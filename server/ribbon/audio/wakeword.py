"""호출어("리본아") 감지.

- MockWakeWord: 절대 깨어나지 않음. 디버그 패널의 '호출' 버튼으로 대신한다.
- OpenWakeWordDetector: openwakeword 커스텀 모델(.onnx / .tflite).
  "리본아" 모델은 TTS 로 합성한 음성 수천 개 + 실제 아이 발화 녹음으로 학습해야 한다.
  학습 절차는 docs/ARCHITECTURE.md 의 '호출어' 항목 참고.
"""
from __future__ import annotations

import time
from typing import Protocol

import numpy as np

from ..config import Settings


class WakeWordDetector(Protocol):
    def process(self, pcm: np.ndarray) -> bool: ...


class MockWakeWord:
    def process(self, pcm: np.ndarray) -> bool:
        return False


class OpenWakeWordDetector:
    def __init__(self, settings: Settings, cooldown_s: float = 2.0):
        from openwakeword.model import Model  # 지연 임포트

        if not settings.wakeword_model_path:
            raise ValueError("RIBBON_WAKEWORD_MODEL_PATH 가 비어 있습니다.")
        self._model = Model(wakeword_models=[settings.wakeword_model_path])
        self._threshold = settings.wakeword_threshold
        self._cooldown = cooldown_s
        self._last_fire = 0.0

    def process(self, pcm: np.ndarray) -> bool:
        scores = self._model.predict(pcm)
        fired = any(v >= self._threshold for v in scores.values())
        now = time.time()
        if fired and now - self._last_fire > self._cooldown:
            self._last_fire = now
            return True
        return False


def make_wakeword(settings: Settings) -> WakeWordDetector:
    if settings.wakeword_provider == "openwakeword":
        return OpenWakeWordDetector(settings)
    return MockWakeWord()
