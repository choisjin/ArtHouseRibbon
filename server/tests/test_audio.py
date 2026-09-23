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


def test_hold_drops_speech_and_restarts_follow_up_window():
    """리본이가 말하는 동안(에코 막기) 잘라 두던 소리를 버리고, 이어 말할 시간은 말이 끝난 뒤부터 잰다"""
    s = Settings(vad_silence_ms=300, follow_up_window_s=1.0)
    proc = ChannelProcessor(0, s, _AlwaysWake())
    proc.start_listening(now=0.0)
    for f in _frames(_tone(0.4)):
        proc.feed(f, now=0.1)
    assert proc.segmenter.in_speech
    proc.hold(now=5.0)                          # 말하는 중에는 feed 대신 hold
    assert not proc.segmenter.in_speech
    assert proc.state == "listening"
    events = [k for f in _frames(_silence(0.1)) for k, _ in proc.feed(f, now=5.5)]
    assert "sleep" not in events and "utterance" not in events


def test_segmenter_drops_quiet_utterance_far_away():
    """가까이서 말한 것만 (2026-09-23): 기준을 겨우 넘는 소리(멀리서 한 말)는 버리고, 충분히 큰 소리만 넘긴다"""
    seg = UtteranceSegmenter(EnergyVAD(0.04), 16000, silence_ms=500, max_utterance_s=10)
    # 사인파 RMS = amp/√2. amp 0.08 -> RMS 0.057: 기준(0.04)은 넘지만 2배(0.08)에는 못 미친다
    quiet = np.concatenate([_silence(0.5), _tone(1.0, amp=0.08), _silence(1.0)])
    assert [u for u in (seg.push(f) for f in _frames(quiet)) if u is not None] == []
    assert seg.dropped_quiet == 1
    # amp 0.3 -> RMS 0.21: 가까이서 한 말
    loud = np.concatenate([_silence(0.5), _tone(1.0, amp=0.3), _silence(1.0)])
    utts = [u for u in (seg.push(f) for f in _frames(loud)) if u is not None]
    assert len(utts) == 1
    assert seg.last_peak > 0.08


def test_flush_returns_speech_so_far_without_waiting_for_silence():
    """호출 버튼 한 번 더 = "거기까지" (2026-09-23): 침묵 없이도 지금까지 모은 말을 바로 내놓는다"""
    seg = UtteranceSegmenter(EnergyVAD(0.015), 16000, silence_ms=1300, max_utterance_s=10)
    assert seg.flush() is None                              # 아직 말이 없다
    for f in _frames(np.concatenate([_silence(0.3), _tone(1.0)])):
        assert seg.push(f) is None                          # 침묵이 없어 아직 안 나온다
    out = seg.flush()
    assert out is not None and 1.0 * 16000 <= out.size <= 1.4 * 16000
    assert not seg.in_speech and seg.flush() is None        # 비웠다


def test_flush_drops_too_short_or_quiet():
    seg = UtteranceSegmenter(EnergyVAD(0.04), 16000, silence_ms=1300, max_utterance_s=10)
    for f in _frames(_tone(0.1)):                           # 0.1초: 너무 짧다
        seg.push(f)
    assert seg.flush() is None
    for f in _frames(_tone(1.0, amp=0.08)):                 # 기준은 넘지만 2배에는 못 미침 (멀리서)
        seg.push(f)
    assert seg.flush() is None


def test_channel_processor_flush_single_shot_closes():
    proc = ChannelProcessor(0, Settings(), _AlwaysWake())
    assert proc.flush() is None                             # idle 이면 없다
    proc.single_shot = True
    proc.start_listening(0.0)
    for f in _frames(_tone(1.0)):
        proc.feed(f, 0.5)
    out = proc.flush()
    assert out is not None and out.size >= 16000
    assert proc.state == "idle"                             # 버튼 방식: 말 한 번 받았으니 닫는다


def test_channel_processor_set_speech_rms_changes_threshold():
    proc = ChannelProcessor(0, Settings(), _AlwaysWake())
    proc.set_speech_rms(0.1)
    assert proc.segmenter.vad.rms_threshold == 0.1
    proc.set_speech_rms(5.0)                     # 말도 안 되는 값은 잘라 둔다
    assert proc.segmenter.vad.rms_threshold == 0.3
