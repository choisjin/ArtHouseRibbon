"""발화 구간 분리.

EnergyVAD 는 RMS 에너지 기준의 단순 판정이라 조용한 교실에서 1차 검증용으로 충분하다.
정확도가 필요해지면 Silero VAD 를 같은 is_speech 인터페이스로 추가한다.
"""
from __future__ import annotations

from typing import List, Optional

import numpy as np


class EnergyVAD:
    def __init__(self, rms_threshold: float = 0.015):
        self.rms_threshold = rms_threshold

    def is_speech(self, pcm: np.ndarray) -> bool:
        if pcm.size == 0:
            return False
        x = pcm.astype(np.float32) / 32768.0
        return float(np.sqrt(np.mean(x * x))) > self.rms_threshold


class UtteranceSegmenter:
    """프레임을 받아 '말 시작 ~ 침묵 silence_ms' 단위의 발화를 잘라낸다."""

    def __init__(self, vad: EnergyVAD, sample_rate: int, silence_ms: int, max_utterance_s: int,
                 pre_roll_ms: int = 300):
        self.vad = vad
        self.sample_rate = sample_rate
        self.silence_samples = int(sample_rate * silence_ms / 1000)
        self.max_samples = int(sample_rate * max_utterance_s)
        self.pre_roll_samples = int(sample_rate * pre_roll_ms / 1000)
        self.reset()

    def reset(self) -> None:
        self._in_speech = False
        self._buf: List[np.ndarray] = []
        self._buf_len = 0
        self._silence = 0
        self._pre: List[np.ndarray] = []
        self._pre_len = 0

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    def push(self, pcm: np.ndarray) -> Optional[np.ndarray]:
        """발화가 끝났으면 그 구간의 PCM 을 반환, 아니면 None."""
        speech = self.vad.is_speech(pcm)
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
            return None

        self._buf.append(pcm)
        self._buf_len += pcm.size
        self._silence = 0 if speech else self._silence + pcm.size
        if self._silence >= self.silence_samples or self._buf_len >= self.max_samples:
            out = np.concatenate(self._buf) if self._buf else np.zeros(0, dtype=np.int16)
            self.reset()
            return out
        return None
