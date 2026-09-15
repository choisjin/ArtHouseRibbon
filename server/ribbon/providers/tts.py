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


def make_tts(settings: Settings) -> TTS:
    if settings.tts_provider == "mac_say":
        return MacSayTTS()
    return BrowserTTS()
