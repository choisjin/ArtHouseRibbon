"""음성 인식 제공자.

- MockSTT: 항상 빈 문자열 (디버그 패널의 텍스트 입력으로 흐름을 확인할 때)
- FasterWhisperSTT: CPU/CUDA. 맥미니에서는 mlx-whisper 로 바꾸는 것을 권장 (같은 인터페이스로 추가)
"""
from __future__ import annotations

import asyncio
from typing import Protocol

import numpy as np

from ..config import Settings


class STT(Protocol):
    async def transcribe(self, pcm: np.ndarray, sample_rate: int) -> str: ...


class MockSTT:
    async def transcribe(self, pcm: np.ndarray, sample_rate: int) -> str:
        return ""


class FasterWhisperSTT:
    def __init__(self, settings: Settings):
        from faster_whisper import WhisperModel  # 지연 임포트: 설치 안 된 환경에서도 서버가 뜨도록

        self._model = WhisperModel(settings.stt_model, device="auto", compute_type="auto")
        self._language = settings.stt_language

    async def transcribe(self, pcm: np.ndarray, sample_rate: int) -> str:
        audio = pcm.astype(np.float32) / 32768.0
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._run, audio)

    def _run(self, audio: np.ndarray) -> str:
        segments, _ = self._model.transcribe(audio, language=self._language, vad_filter=False, beam_size=1)
        return " ".join(s.text.strip() for s in segments).strip()


class MLXWhisperSTT:
    """Apple Silicon 전용. pip install mlx-whisper. 첫 실행 때 모델을 내려받는다.

    MLX 는 스레드마다 스트림이 따로 있어서 여러 스레드에서 번갈아 부르면
    'There is no Stream(cpu, 1) in current thread' 로 죽는다. 그래서 전용 스레드 하나에서만 돌린다.
    (두 채널이 동시에 발화하면 순서대로 처리된다.)
    """

    def __init__(self, settings: Settings):
        import mlx_whisper  # 지연 임포트
        from concurrent.futures import ThreadPoolExecutor

        self._mlx = mlx_whisper
        name = settings.stt_model
        self._repo = name if "/" in name else f"mlx-community/whisper-{name}"
        self._language = settings.stt_language
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx-stt")

    async def transcribe(self, pcm: np.ndarray, sample_rate: int) -> str:
        audio = pcm.astype(np.float32) / 32768.0
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._pool, self._run, audio)

    def _run(self, audio: np.ndarray) -> str:
        result = self._mlx.transcribe(audio, path_or_hf_repo=self._repo, language=self._language)
        return str(result.get("text", "")).strip()


def make_stt(settings: Settings) -> STT:
    if settings.stt_provider == "faster_whisper":
        return FasterWhisperSTT(settings)
    if settings.stt_provider == "mlx_whisper":
        return MLXWhisperSTT(settings)
    return MockSTT()
