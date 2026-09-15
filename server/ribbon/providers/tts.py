"""음성 합성 제공자.

- BrowserTTS: 합성하지 않고 텍스트만 보내 TV 클라이언트의 speechSynthesis 가 읽음 (개발용, 설치 불필요)
- MacSayTTS: 맥미니 내장 `say` (한국어 Yuna 음성) 로 wav 생성 -> base64 로 전송
- 이후 Kokoro / MeloTTS 등 로컬 모델은 같은 인터페이스로 추가
"""
from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from typing import Optional, Protocol

from ..config import Settings


class TTS(Protocol):
    async def synthesize(self, text: str) -> Optional[bytes]:
        """wav 바이트를 반환. None 이면 클라이언트가 직접 읽는다."""
        ...


def configure_tts(tts: object, voice: Optional[str], speed: Optional[float], steps: Optional[int]) -> None:
    """제공자가 configure 를 지원하면 적용 (browser/mac_say 는 무시)."""
    fn = getattr(tts, "configure", None)
    if callable(fn):
        fn(voice=voice, speed=speed, steps=steps)


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
        self._lang = "ko"

    def configure(self, voice: Optional[str] = None, speed: Optional[float] = None, steps: Optional[int] = None) -> None:
        """관리자 페이지에서 목소리/속도/품질을 바꿀 때. 서버 재시작 없이 적용."""
        if voice and voice != self._voice:
            self._style = self._tts.get_voice_style(voice_name=voice)
            self._voice = voice
        if speed:
            self._speed = max(0.7, min(2.0, float(speed)))
        if steps:
            self._steps = max(5, min(12, int(steps)))

    async def synthesize(self, text: str, voice: Optional[str] = None, speed: Optional[float] = None) -> Optional[bytes]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._run, text, voice, speed)

    def _run(self, text: str, voice: Optional[str] = None, speed: Optional[float] = None) -> Optional[bytes]:
        style = self._tts.get_voice_style(voice_name=voice) if voice and voice != self._voice else self._style
        wav, _duration = self._tts.synthesize(
            text=text, voice_style=style, total_steps=self._steps, speed=speed or self._speed,
            lang=self._lang, verbose=False)
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
