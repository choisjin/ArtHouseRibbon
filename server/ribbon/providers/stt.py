"""음성 인식 제공자.

- MockSTT: 항상 빈 문자열 (디버그 패널의 텍스트 입력으로 흐름을 확인할 때)
- FasterWhisperSTT: CPU/CUDA. 맥미니에서는 mlx-whisper 로 바꾸는 것을 권장 (같은 인터페이스로 추가)
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Iterable, Protocol

import numpy as np

from ..config import Settings

log = logging.getLogger("ribbon.stt")

# Whisper 는 유튜브 자막으로 배워서, 아무도 말하지 않는 잡음·조용한 소리에서 이런 문장을 지어낸다.
# 리본이가 이걸 아이 말로 알고 대답하면 혼자 대화가 끝없이 이어진다 (2026-09-20 맥미니). 띄어쓰기·문장부호는 빼고 비교
_HALLUCINATION_EXACT = {
    "감사합니다", "고맙습니다", "다음영상에서만나요", "다음영상에서뵙겠습니다", "다음영상에서만나요감사합니다",
    "시청해주셔서감사합니다", "시청해주셔서고맙습니다", "끝까지시청해주셔서감사합니다", "오늘도시청해주셔서감사합니다",
    "구독과좋아요부탁드립니다", "구독과좋아요", "좋아요와구독부탁드립니다", "아",
}
_HALLUCINATION_PARTS = ("시청해주셔서", "구독과좋아요", "좋아요와구독", "구독좋아요", "알림설정", "다음영상",
                        "mbc뉴스", "자막제공", "자막by", "한글자막")


def _norm(text: str) -> str:
    return re.sub(r"[\s.,!?~…·'\"“”‘’]", "", text).lower()


def is_hallucination(text: str) -> bool:
    n = _norm(text)
    return not n or n in _HALLUCINATION_EXACT or any(p in n for p in _HALLUCINATION_PARTS)


def clean_segments(segments: Iterable[Any]) -> str:
    """Whisper 구간들 중 말이 아닐 가능성이 큰 것을 버리고 이어 붙인다 (mlx 는 dict, faster-whisper 는 객체)"""
    def get(seg: Any, key: str, default: float) -> Any:
        return seg.get(key, default) if isinstance(seg, dict) else getattr(seg, key, default)

    keep = []
    for seg in segments:
        text = str(get(seg, "text", "")).strip()
        no_speech = float(get(seg, "no_speech_prob", 0.0))
        logprob = float(get(seg, "avg_logprob", 0.0))
        ratio = float(get(seg, "compression_ratio", 1.0))
        if no_speech > 0.6 or logprob < -1.0 or ratio > 2.4 or is_hallucination(text):
            log.info("말이 아닌 것 같아 버림: %r (no_speech=%.2f logprob=%.2f)", text, no_speech, logprob)
            continue
        keep.append(text)
    return " ".join(keep).strip()


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
        segments, _ = self._model.transcribe(audio, language=self._language, vad_filter=False, beam_size=1,
                                             condition_on_previous_text=False)
        return clean_segments(segments)


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
        result = self._mlx.transcribe(audio, path_or_hf_repo=self._repo, language=self._language,
                                      condition_on_previous_text=False)
        return clean_segments(result.get("segments") or [])


def make_stt(settings: Settings) -> STT:
    if settings.stt_provider == "faster_whisper":
        return FasterWhisperSTT(settings)
    if settings.stt_provider == "mlx_whisper":
        return MLXWhisperSTT(settings)
    return MockSTT()
