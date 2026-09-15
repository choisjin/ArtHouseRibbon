import numpy as np

from ribbon.audio.stream import ChannelProcessor
from ribbon.audio.vad import EnergyVAD, UtteranceSegmenter
from ribbon.config import Settings


def _tone(seconds: float, sr: int = 16000, amp: float = 0.3) -> np.ndarray:
    t = np.arange(int(seconds * sr)) / sr
    return (np.sin(2 * np.pi * 220 * t) * amp * 32767).astype(np.int16)


def _silence(seconds: float, sr: int = 16000) -> np.ndarray:
    return np.zeros(int(seconds * sr), dtype=np.int16)


def _frames(pcm: np.ndarray, frame: int = 320):
    for i in range(0, len(pcm) - frame + 1, frame):
        yield pcm[i:i + frame]


def test_segmenter_cuts_utterance_after_silence():
    seg = UtteranceSegmenter(EnergyVAD(0.015), 16000, silence_ms=500, max_utterance_s=10)
    audio = np.concatenate([_silence(0.5), _tone(1.0), _silence(1.0)])
    out = [seg.push(f) for f in _frames(audio)]
    utts = [u for u in out if u is not None]
    assert len(utts) == 1
    assert 1.0 * 16000 <= utts[0].size <= 2.0 * 16000


class _AlwaysWake:
    def __init__(self):
        self.fired = False

    def process(self, pcm):
        if not self.fired:
            self.fired = True
            return True
        return False


class _WakeAfter:
    """n번째 프레임에서 깨어나는 호출어 흉내 (에너지 호출처럼 말하는 도중 깨어남)"""
    def __init__(self, n):
        self.n = n; self.i = 0; self.fired = False
    def process(self, pcm):
        self.i += 1
        if not self.fired and self.i >= self.n:
            self.fired = True
            return True
        return False


def test_speech_before_wake_is_kept():
    s = Settings(vad_silence_ms=300, follow_up_window_s=1.0)
    proc = ChannelProcessor(0, s, _WakeAfter(18))  # 소리 시작 후 ~360ms 뒤에 깨어남
    audio = np.concatenate([_tone(0.8), _silence(1.0)])
    utts = []
    now = 0.0
    for f in _frames(audio):
        for kind, payload in proc.feed(f, now=now):
            if kind == "utterance": utts.append(payload)
        now += 0.02
    assert len(utts) == 1
    assert utts[0].size >= int(0.75 * 16000)  # 깨어나기 전 소리까지 거의 전부 포함


def test_channel_processor_wake_then_utterance_then_sleep():
    s = Settings(vad_silence_ms=300, follow_up_window_s=1.0)
    proc = ChannelProcessor(0, s, _AlwaysWake())
    now = 0.0
    events = []
    audio = np.concatenate([_silence(0.2), _tone(0.6), _silence(2.0)])
    for f in _frames(audio):
        for kind, _ in proc.feed(f, now=now):
            events.append(kind)
        now += 0.02
    assert events[0] == "wake"
    assert "utterance" in events
    assert events[-1] == "sleep"
    assert proc.state == "idle"
