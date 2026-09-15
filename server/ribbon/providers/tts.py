"""음성 합성 제공자.

- BrowserTTS: 합성하지 않고 텍스트만 보내 TV 클라이언트의 speechSynthesis 가 읽음 (개발용, 설치 불필요)
- MacSayTTS: 맥미니 내장 `say` (한국어 Yuna 음성) 로 wav 생성 -> base64 로 전송
- 이후 Kokoro / MeloTTS 등 로컬 모델은 같은 인터페이스로 추가
"""
from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path
from typing import Optional, Protocol

import numpy as np

from ..config import Settings

log = logging.getLogger("ribbon.tts")


class TTS(Protocol):
    async def synthesize(self, text: str) -> Optional[bytes]:
        """wav 바이트를 반환. None 이면 클라이언트가 직접 읽는다."""
        ...


def configure_tts(tts: object, voice: Optional[str], speed: Optional[float], steps: Optional[int],
                  pitch: Optional[float] = None) -> None:
    """제공자가 configure 를 지원하면 적용 (browser/mac_say 는 무시)."""
    fn = getattr(tts, "configure", None)
    if callable(fn):
        fn(voice=voice, speed=speed, steps=steps, pitch=pitch)


def pitch_shift(wav: "np.ndarray", sample_rate: int, semitones: float) -> "np.ndarray":
    """길이를 유지한 채 음높이만 바꾼다 (librosa). 0 이면 그대로."""
    if not semitones:
        return wav
    try:
        import librosa  # 지연 임포트: 없으면 피치만 건너뛴다
    except ImportError:
        log.warning("librosa 가 없어 피치 조절을 건너뜁니다 (pip install librosa)")
        return wav
    mono = wav[0] if wav.ndim == 2 else wav
    shifted = librosa.effects.pitch_shift(mono.astype("float32"), sr=sample_rate, n_steps=float(semitones))
    return shifted[None, :] if wav.ndim == 2 else shifted


class BrowserTTS:
    async def synthesize(self, text: str) -> Optional[bytes]:
        return None


class MacSayTTS:
    def __init__(self, voice: str = "Yuna", rate: int = 180):
        self.voice = voice
        self.rate = rate

    async def synthesize(self, text: str) -> Optional[bytes]:
        with tempfile.TemporaryDirectory() as tmp:
            aiff = Path(tmp) / "out.aiff"
            wav = Path(tmp) / "out.wav"
            p = await asyncio.create_subprocess_exec(
                "say", "-v", self.voice, "-r", str(self.rate), "-o", str(aiff), text)
            await p.wait()
            p = await asyncio.create_subprocess_exec(
                "afconvert", "-f", "WAVE", "-d", "LEI16@22050", str(aiff), str(wav))
            await p.wait()
            return wav.read_bytes() if wav.exists() else None


class SupertonicTTS:
    """수퍼톤 Supertonic (ONNX, 온디바이스). pip install supertonic. 첫 실행 때 모델을 내려받는다.

    내장 음성 M1~M5, F1~F5. 한국어는 lang="ko". 44.1kHz 16bit wav 를 돌려준다.
    합성은 스레드 풀에서 돌려 이벤트 루프를 막지 않는다.
    """

    def __init__(self, settings: Settings):
        from supertonic import TTS as _TTS  # 지연 임포트

        self._tts = _TTS(auto_download=True)
        self._voice = settings.tts_voice
        self._style = self._tts.get_voice_style(voice_name=self._voice)
        self._speed = settings.tts_speed
        self._steps = settings.tts_steps
        self._pitch = 0.0
        self._lang = "ko"
        self._sample_rate = int(getattr(self._tts, "sample_rate", 44100))
        # librosa 피치 변환은 첫 호출에 JIT 컴파일로 10초 넘게 걸린다. 서버 시작 때 뒤에서 미리 예열한다.
        import threading
        threading.Thread(target=self._warmup_pitch, daemon=True).start()

    def _warmup_pitch(self) -> None:
        try:
            pitch_shift(np.zeros((1, self._sample_rate // 2), dtype="float32"), self._sample_rate, 1.0)
        except Exception as e:  # noqa: BLE001
            log.warning("피치 예열 실패: %s", e)

    def configure(self, voice: Optional[str] = None, speed: Optional[float] = None, steps: Optional[int] = None,
                  pitch: Optional[float] = None) -> None:
        """관리자 페이지에서 목소리/속도/품질/피치를 바꿀 때. 서버 재시작 없이 적용."""
        if voice and voice != self._voice:
            self._style = self._tts.get_voice_style(voice_name=voice)
            self._voice = voice
        if speed:
            self._speed = max(0.7, min(2.0, float(speed)))
        if steps:
            self._steps = max(5, min(12, int(steps)))
        if pitch is not None:
            self._pitch = max(-8.0, min(10.0, float(pitch)))

    async def synthesize(self, text: str, voice: Optional[str] = None, speed: Optional[float] = None,
                         steps: Optional[int] = None, pitch: Optional[float] = None) -> Optional[bytes]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._run, text, voice, speed, steps, pitch)

    def _run(self, text: str, voice: Optional[str] = None, speed: Optional[float] = None,
             steps: Optional[int] = None, pitch: Optional[float] = None) -> Optional[bytes]:
        style = self._tts.get_voice_style(voice_name=voice) if voice and voice != self._voice else self._style
        wav, _duration = self._tts.synthesize(
            text=text, voice_style=style, total_steps=int(steps or self._steps), speed=float(speed or self._speed),
            lang=self._lang, verbose=False)
        wav = pitch_shift(wav, self._sample_rate, self._pitch if pitch is None else float(pitch))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "out.wav"
            self._tts.save_audio(wav, str(path))
            return path.read_bytes() if path.exists() else None


def make_tts(settings: Settings) -> TTS:
    if settings.tts_provider == "mac_say":
        return MacSayTTS()
    if settings.tts_provider == "supertonic":
        return SupertonicTTS(settings)
    return BrowserTTS()
