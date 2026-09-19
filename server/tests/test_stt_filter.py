"""아무도 말하지 않았는데 대화가 이어지던 문제: Whisper 환각·짧은 잡음 거르기"""
import numpy as np

from ribbon.audio.vad import EnergyVAD, UtteranceSegmenter
from ribbon.providers.stt import clean_segments, is_hallucination


def test_youtube_style_hallucinations_are_dropped():
    for t in ["다음 영상에서 만나요.", "감사합니다.", "시청해 주셔서 감사합니다!", "구독과 좋아요 부탁드립니다"]:
        assert is_hallucination(t), t
    for t in ["네", "공룡 그렸어", "선생님 감사합니다 저 다 했어요", "다음에 또 놀자"]:
        assert not is_hallucination(t), t


def test_low_confidence_segments_are_dropped():
    segs = [
        {"text": "강아지 그렸어", "no_speech_prob": 0.05, "avg_logprob": -0.3, "compression_ratio": 1.1},
        {"text": "무슨 말", "no_speech_prob": 0.9, "avg_logprob": -0.4, "compression_ratio": 1.1},
        {"text": "웅얼웅얼", "no_speech_prob": 0.1, "avg_logprob": -1.5, "compression_ratio": 1.1},
        {"text": "감사합니다.", "no_speech_prob": 0.2, "avg_logprob": -0.2, "compression_ratio": 1.0},
    ]
    assert clean_segments(segs) == "강아지 그렸어"


def _frames(level, n):
    return [np.full(320, level, dtype=np.int16) for _ in range(n)]   # 20ms 프레임


def test_short_noise_burst_is_not_an_utterance():
    seg = UtteranceSegmenter(EnergyVAD(0.015), 16000, silence_ms=300, max_utterance_s=10)
    out = [seg.push(f) for f in _frames(3000, 5) + _frames(0, 20)]   # 딸깍 0.1초
    assert all(o is None for o in out)
    out = [seg.push(f) for f in _frames(3000, 25) + _frames(0, 20)]  # 말 0.5초
    assert any(o is not None for o in out)
