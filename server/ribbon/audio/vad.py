"""발화 구간 분리.

EnergyVAD 는 RMS 에너지 기준의 단순 판정이라 조용한 교실에서 1차 검증용으로 충분하다.
정확도가 필요해지면 Silero VAD 를 같은 is_speech 인터페이스로 추가한다.
"""
from __future__ import annotations

from typing import List, Optional

import numpy as np


def frame_rms(pcm: np.ndarray) -> float:
    if pcm.size == 0:
        return 0.0
    x = pcm.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(x * x)))


class EnergyVAD:
    def __init__(self, rms_threshold: float = 0.015):
        self.rms_threshold = rms_threshold

    def is_speech(self, pcm: np.ndarray) -> bool:
        return frame_rms(pcm) > self.rms_threshold


class UtteranceSegmenter:
    """프레임을 받아 '말 시작 ~ 침묵 silence_ms' 단위의 발화를 잘라낸다."""

    #: 가까이서 말한 것만 (2026-09-23): 발화 안에서 가장 큰 프레임이 기준의 이 배수에도 못 미치면 버린다.
    #: 멀리서 하는 말·방 소리는 기준을 겨우 넘나들고, 마이크 가까이서 하는 말은 훌쩍 넘는다
    PEAK_RATIO = 2.0

    def __init__(self, vad: EnergyVAD, sample_rate: int, silence_ms: int, max_utterance_s: int,
                 pre_roll_ms: int = 300, min_voiced_ms: int = 250):
        self.vad = vad
        self.sample_rate = sample_rate
        self.silence_samples = int(sample_rate * silence_ms / 1000)
        self.max_samples = int(sample_rate * max_utterance_s)
        self.pre_roll_samples = int(sample_rate * pre_roll_ms / 1000)
        # 소리가 큰 프레임이 이만큼도 안 되면 말이 아니라 잡음(딸깍, 부딪힘)으로 보고 버린다.
        # Whisper 는 이런 조각에서 "감사합니다" 같은 문장을 지어낸다
        self.min_voiced_samples = int(sample_rate * min_voiced_ms / 1000)
        self.last_peak = 0.0          # 마지막으로 잘라낸(또는 버린) 발화의 가장 큰 프레임 RMS (로그용)
        self.dropped_quiet = 0        # 작아서 버린 발화 수 (로그용)
        self.reset()

    def reset(self) -> None:
        self._in_speech = False
        self._buf: List[np.ndarray] = []
        self._buf_len = 0
        self._silence = 0
        self._voiced = 0
        self._peak = 0.0
        self._pre: List[np.ndarray] = []
        self._pre_len = 0

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    def push(self, pcm: np.ndarray) -> Optional[np.ndarray]:
        """발화가 끝났으면 그 구간의 PCM 을 반환, 아니면 None."""
        rms = frame_rms(pcm)
        speech = rms > self.vad.rms_threshold
        if not self._in_speech:
            self._pre.append(pcm)
            self._pre_len += pcm.size
            while self._pre_len > self.pre_roll_samples and len(self._pre) > 1:
                self._pre_len -= self._pre.pop(0).size
            if speech:
                self._in_speech = True
                self._buf = list(self._pre)
                self._buf_len = self._pre_len
                self._silence = 0
                self._voiced = pcm.size
                self._peak = rms
            return None

        self._buf.append(pcm)
        self._buf_len += pcm.size
        self._silence = 0 if speech else self._silence + pcm.size
        if speech:
            self._voiced += pcm.size
            self._peak = max(self._peak, rms)
        if self._silence >= self.silence_samples or self._buf_len >= self.max_samples:
            out = np.concatenate(self._buf) if self._buf else np.zeros(0, dtype=np.int16)
            voiced, peak = self._voiced, self._peak
            self.reset()
            self.last_peak = peak
            if voiced < self.min_voiced_samples:
                return None                       # 짧은 잡음
            if peak < self.vad.rms_threshold * self.PEAK_RATIO:
                self.dropped_quiet += 1           # 기준을 겨우 넘은 소리: 멀리서 한 말·방 소리
                return None
            return out
        return None
