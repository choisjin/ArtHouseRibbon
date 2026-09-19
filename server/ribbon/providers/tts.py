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
from ..voices import get_preset

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


def detect_lang(text: str, default: str = "ko") -> str:
    """문장의 주 언어. 한글이 하나라도 있으면 ko, 로마자만 있으면 en. (영어 대화 모드용)"""
    hangul = sum(1 for ch in text if "가" <= ch <= "힣")
    latin = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    if hangul == 0 and latin >= 2:
        return "en"
    if latin > hangul * 3:
        return "en"
    return default


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


def world_child(wav: "np.ndarray", sample_rate: int, pitch: float = 1.15, formant: float = 1.10) -> "np.ndarray":
    """아이 목소리 변환 (pyworld). 음높이와 울림(스펙트럼 포락선)을 따로 올린다.
    울림을 올리면 성도가 짧은 = 어린 목소리처럼 들린다. 피치만 올리는 것보다 다람쥐 소리가 덜 난다."""
    import pyworld as pw  # 지연 임포트. setuptools<81 이 필요하다 (pkg_resources)
    x = np.asarray(wav, dtype=np.float64).reshape(-1)
    f0, t = pw.dio(x, sample_rate, frame_period=5.0)
    f0 = pw.stonemask(x, f0, t, sample_rate)
    sp = pw.cheaptrick(x, f0, t, sample_rate)
    ap = pw.d4c(x, f0, t, sample_rate)
    n = sp.shape[1]
    src = np.arange(n) / formant               # 새 주파수 k 는 원래 k/formant 자리의 값
    lo = np.clip(np.floor(src).astype(int), 0, n - 1)
    hi = np.clip(lo + 1, 0, n - 1)
    w = src - np.floor(src)
    sp2 = sp[:, lo] * (1 - w) + sp[:, hi] * w
    ap2 = ap[:, lo] * (1 - w) + ap[:, hi] * w
    y = pw.synthesize(f0 * pitch, np.ascontiguousarray(sp2), np.ascontiguousarray(ap2), sample_rate, 5.0)
    peak = np.abs(y).max()
    if peak > 0.99:
        y = y / peak * 0.99
    return y.astype(np.float32)


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

    내장 음성 M1~M5, F1~F5 와 그걸 섞은 조합(ribbon/voices.py). 한국어는 lang="ko". 44.1kHz 16bit wav 를 돌려준다.
    합성은 스레드 풀에서 돌려 이벤트 루프를 막지 않는다.
    """

    def __init__(self, settings: Settings):
        from supertonic import TTS as _TTS  # 지연 임포트

        self._tts = _TTS(auto_download=True)
        self._styles: dict = {}          # voice id -> Style (섞은 것도 한 번 만들면 재사용)
        self._world_ok: Optional[bool] = None
        self._voice = settings.tts_voice
        self._style = self._style_of(self._voice)
        self._speed = settings.tts_speed
        self._steps = settings.tts_steps
        self._pitch = 0.0
        self._lang = "ko"
        self._sample_rate = int(getattr(self._tts, "sample_rate", 44100))
        # librosa 피치 변환은 첫 호출에 JIT 컴파일로 10초 넘게 걸린다. 서버 시작 때 뒤에서 미리 예열한다.
        import threading
        threading.Thread(target=self._warmup_pitch, daemon=True).start()

    def _style_of(self, voice: str):
        """voice id -> Supertonic Style. 조합이면 기본 목소리 벡터를 비율대로 섞는다. 모르는 id 는 F1"""
        if voice in self._styles:
            return self._styles[voice]
        preset = get_preset(voice)
        if preset is None:
            log.warning("모르는 목소리 %r -> F1 로", voice)
            preset = get_preset("F1")
        from supertonic.core import Style
        base = {v: self._tts.get_voice_style(voice_name=v) for v in {**preset.ttl, **preset.dp}}
        style = Style(sum(r * base[v].ttl for v, r in preset.ttl.items()).astype(np.float32),
                      sum(r * base[v].dp for v, r in preset.dp.items()).astype(np.float32))
        self._styles[voice] = style
        return style

    def _child(self, wav: "np.ndarray", voice: str) -> "np.ndarray":
        preset = get_preset(voice)
        if not preset or not preset.child:
            return wav
        if self._world_ok is None:
            try:
                import pyworld  # noqa: F401
                self._world_ok = True
            except ImportError as e:
                self._world_ok = False
                log.warning("pyworld 를 불러오지 못해 아이 목소리 변환을 건너뜁니다 (pip install pyworld 'setuptools<81'): %r", e)
        if not self._world_ok:
            return wav
        y = world_child(wav, self._sample_rate, *preset.child)
        return y[None, :] if np.asarray(wav).ndim == 2 else y

    def _warmup_pitch(self) -> None:
        try:
            pitch_shift(np.zeros((1, self._sample_rate // 2), dtype="float32"), self._sample_rate, 1.0)
        except Exception as e:  # noqa: BLE001
            log.warning("피치 예열 실패: %s", e)

    def configure(self, voice: Optional[str] = None, speed: Optional[float] = None, steps: Optional[int] = None,
                  pitch: Optional[float] = None) -> None:
        """관리자 페이지에서 목소리/속도/품질/피치를 바꿀 때. 서버 재시작 없이 적용."""
        if voice and voice != self._voice:
            self._style = self._style_of(voice)
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
        voice = voice or self._voice
        style = self._style if voice == self._voice else self._style_of(voice)
        lang = detect_lang(text, self._lang)  # 영어 문장은 영어 발음으로
        wav, _duration = self._tts.synthesize(
            text=text, voice_style=style, total_steps=int(steps or self._steps), speed=float(speed or self._speed),
            lang=lang, verbose=False)
        wav = self._child(wav, voice)
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
