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

    def start_listening(self, now: Optional[float] = None, window_s: Optional[float] = None) -> None:
        now = time.time() if now is None else now
        window_s = self.settings.follow_up_window_s if window_s is None else window_s
        self.state = "listening"
        self._listen_until = now + window_s
        self.segmenter.reset()

    def stop_listening(self) -> None:
        self.state = "idle"
        self.segmenter.reset()

    def feed(self, pcm: np.ndarray, now: Optional[float] = None) -> List[Event]:
        now = time.time() if now is None else now
        events: List[Event] = []
        if self.state == "idle":
            if self.wakeword.process(pcm):
                self.start_listening(now)
                events.append(("wake", None))
            return events

        utterance = self.segmenter.push(pcm)
        if utterance is not None and utterance.size > 0:
            events.append(("utterance", utterance))
            self._listen_until = now + self.settings.follow_up_window_s
        elif not self.segmenter.in_speech and now > self._listen_until:
            self.stop_listening()
            events.append(("sleep", None))
        return events
