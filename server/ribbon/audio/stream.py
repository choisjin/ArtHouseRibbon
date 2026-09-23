"""채널(=아이) 하나의 오디오 상태 기계.

idle       : 호출어만 감시한다. 말은 기록하지 않는다.
listening  : 호출어가 감지된 뒤. 발화를 잘라 STT 로 넘긴다.
             마지막 발화 후 follow_up_window 동안은 호출어 없이도 계속 듣는다.
"""
from __future__ import annotations

import time
from typing import List, Optional, Tuple

import numpy as np

from ..config import Settings
from .vad import EnergyVAD, UtteranceSegmenter
from .wakeword import WakeWordDetector

Event = Tuple[str, Optional[np.ndarray]]  # ("wake", None) | ("utterance", pcm) | ("sleep", None)


class ChannelProcessor:
    def __init__(self, channel: int, settings: Settings, wakeword: WakeWordDetector):
        self.channel = channel
        self.settings = settings
        self.wakeword = wakeword
        self.segmenter = UtteranceSegmenter(
            EnergyVAD(settings.vad_rms_threshold), settings.sample_rate,
            settings.vad_silence_ms, settings.max_utterance_s)
        self.state = "idle"
        self._listen_until = 0.0
        # 대기 중에도 최근 프레임을 기억해, 깨어나는 순간 호출 전에 말한 앞부분을 잃지 않는다 (에너지 호출용)
        self._idle_buf: List[np.ndarray] = []
        self._idle_keep = max(1, int(800 / 20))  # 20ms 프레임 × 0.8초
        self.follow_up_s: Optional[float] = None  # 이어 말하기 시간을 잠깐 바꿀 때 (포켓몬 맞추기 중에는 길게)
        # 버튼 방식(input_mode="button"): 말 한 번 받으면 바로 닫고, 말소리로 깨어나지 않는다 (버튼을 눌러야만 듣는다)
        self.single_shot = False
        self.voice_wake = True

    def start_listening(self, now: Optional[float] = None, window_s: Optional[float] = None) -> None:
        now = time.time() if now is None else now
        window_s = self.settings.follow_up_window_s if window_s is None else window_s
        self.state = "listening"
        self._listen_until = now + window_s
        self.segmenter.reset()

    #: 버튼으로만 끝낼 때의 안전장치: 이만큼 지나면 그래도 자른다 (아이가 버튼을 잊었을 때, 메모리·STT 길이)
    BUTTON_ONLY_MAX_S = 120.0

    def set_silence_ms(self, ms: int) -> None:
        """말이 끝났다고 보는 침묵 길이 (관리자 설정, 0.3~4초). 자동 방식용"""
        samples = int(self.settings.sample_rate * max(300, min(4000, int(ms))) / 1000)
        self.segmenter.silence_samples = samples
        self.segmenter.max_samples = int(self.settings.sample_rate * self.settings.max_utterance_s)

    def set_end_by_button_only(self) -> None:
        """말을 끝내는 것은 버튼(flush)만 (2026-09-24 요청): 침묵으로 자르지 않는다. 아이가 말 중간에 아무리 쉬어도
        버튼을 누를 때까지 한 덩어리로 모은다. BUTTON_ONLY_MAX_S 가 지나면 안전장치로 자른다"""
        self.segmenter.silence_samples = float("inf")
        self.segmenter.max_samples = int(self.settings.sample_rate * self.BUTTON_ONLY_MAX_S)

    def set_speech_rms(self, rms: float) -> None:
        """말로 보는 소리 크기 기준 (관리자 설정 '가까이서 말한 것만'). 클수록 마이크 가까이서 말해야 듣는다"""
        self.segmenter.vad.rms_threshold = max(0.005, min(0.3, float(rms)))

    def stop_listening(self) -> None:
        self.state = "idle"
        self.segmenter.reset()

    def hold(self, now: Optional[float] = None) -> None:
        """리본이가 말하는 동안 (에코 막기): 소리를 버리고 잘라 두던 발화도 버린다.
        듣는 중이면 이어 말할 시간(follow-up)은 리본이 말이 끝난 뒤부터 다시 잰다."""
        now = time.time() if now is None else now
        self.segmenter.reset()
        self._idle_buf = []
        if self.state == "listening":
            self._listen_until = now + (self.follow_up_s or self.settings.follow_up_window_s)

    def flush(self) -> Optional[np.ndarray]:
        """듣는 중에 호출 버튼을 한 번 더 눌렀다 = "거기까지" (2026-09-23): 침묵을 기다리지 않고 지금까지 들은 말을
        바로 내놓는다. 버튼 방식(single_shot)이면 말 한 번을 받은 것이라 듣기를 닫는다"""
        if self.state != "listening":
            return None
        out = self.segmenter.flush()
        if out is not None and self.single_shot:
            self.stop_listening()
        return out

    def feed(self, pcm: np.ndarray, now: Optional[float] = None) -> List[Event]:
        now = time.time() if now is None else now
        events: List[Event] = []
        if self.state == "idle":
            self._idle_buf.append(pcm)
            if len(self._idle_buf) > self._idle_keep:
                self._idle_buf.pop(0)
            if self.voice_wake and self.wakeword.process(pcm):
                self.start_listening(now)
                events.append(("wake", None))
                # 깨어나기 전 0.8초(예: "사과가")를 발화 앞에 붙인다. 호출어 모델이면 호출어 자체가 섞이지만 STT 가 걸러낸다
                for f in self._idle_buf:
                    self.segmenter.push(f)
                self._idle_buf = []
            return events

        utterance = self.segmenter.push(pcm)
        if utterance is not None and utterance.size > 0:
            events.append(("utterance", utterance))
            if self.single_shot:
                self.stop_listening()              # 버튼 한 번에 말 한 번: 이어 말하기를 기다리지 않는다
                return events
            self._listen_until = now + (self.follow_up_s or self.settings.follow_up_window_s)
        elif not self.segmenter.in_speech and now > self._listen_until:
            self.stop_listening()
            events.append(("sleep", None))
        return events
