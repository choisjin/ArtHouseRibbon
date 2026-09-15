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
