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


def test_prepare_boosts_quiet_voice_and_cuts_rumble():
    from ribbon.providers.stt import prepare
    sr = 16000
    t = np.arange(sr) / sr
    quiet = (0.03 * np.sin(2 * np.pi * 300 * t) * 32767).astype(np.int16)
    y = prepare(quiet, sr)
    assert 0.2 < float(np.abs(y).max()) <= 1.0                     # 작은 목소리를 키운다
    rumble = (0.3 * np.sin(2 * np.pi * 20 * t) * 32767).astype(np.int16)
    assert float(np.abs(prepare(rumble, sr)).std()) < float(np.abs(rumble / 32768).std())


def test_prompt_echo_only_for_long_repeats():
    from ribbon.providers.stt import _echoes_prompt
    prompt = "지우, 리본. 아이가 리본에게 말한다. 포켓몬 맞추기, 힌트, 정답, 모르겠어, 다음 문제, 그림 보고."
    assert _echoes_prompt("아이가 리본에게 말한다. 포켓몬 맞추기", prompt)
    assert not _echoes_prompt("모르겠어", prompt) and not _echoes_prompt("다음 문제", prompt)


async def test_dialogue_prompt_has_names_not_answer(tmp_path):
    import json
    from ribbon.config import Settings
    from ribbon.dialogue import DialogueManager
    from ribbon.kids.registry import KidRegistry
    from ribbon.knowledge.pokedex import Pokedex
    from ribbon.protocol import KidInfo
    from ribbon.providers.tts import BrowserTTS
    p = tmp_path / "pokedex.json"
    p.write_text(json.dumps({"pokemon": [{"id": 25, "name": "피카츄", "genus": "", "types": ["전기"],
                                          "height_m": 0.4, "weight_kg": 6.0, "evolution": "", "flavor": []}]},
                            ensure_ascii=False), encoding="utf-8")

    async def bc(m):
        pass
    kids = KidRegistry([KidInfo(id="a", name="김준호", nickname="준이", mic_channel=0)])
    dm = DialogueManager(Settings(), kids, None, BrowserTTS(), bc, pokedex=Pokedex(p))
    assert "준이" in dm.stt_prompt() and "김준호" in dm.stt_prompt()
    assert "피카츄" not in dm.stt_prompt()                                # 게임 중이 아니면 포켓몬 이름은 넣지 않는다
    dm.quiz.start("image")
    # 게임 중에는 포켓몬 이름을 알려 준다 (2026-09-21): 안 알려 주면 "삼삼드래" 를 "3343" 으로 적는다
    assert "힌트" in dm.stt_prompt() and "피카츄" in dm.stt_prompt()
    assert len(dm.stt_prompt()) <= 500


def test_mlx_repo_names():
    from ribbon.providers.stt import mlx_repo
    assert mlx_repo("large-v3-turbo") == "mlx-community/whisper-large-v3-turbo"
    assert mlx_repo("large-v3") == "mlx-community/whisper-large-v3-mlx"     # "whisper-large-v3" 는 없다
    assert mlx_repo("whisper-medium") == "mlx-community/whisper-medium-mlx"
    assert mlx_repo("someone/korean-whisper-mlx") == "someone/korean-whisper-mlx"


def test_mlx_falls_back_to_turbo_when_model_missing():
    from ribbon.config import Settings
    from ribbon.providers.stt import FALLBACK_REPO, MLXWhisperSTT
    stt = MLXWhisperSTT.__new__(MLXWhisperSTT)
    stt._repo, stt._language = "mlx-community/whisper-large-v3", "ko"
    calls = []

    class FakeMlx:
        @staticmethod
        def transcribe(audio, path_or_hf_repo, **kw):
            calls.append(path_or_hf_repo)
            if path_or_hf_repo != FALLBACK_REPO:
                raise OSError("401 Repository Not Found")
            return {"segments": [{"text": "안녕", "no_speech_prob": 0.0, "avg_logprob": -0.1}]}
    stt._mlx = FakeMlx
    assert stt._run(np.zeros(1600, np.float32)) == "안녕"
    assert stt._repo == FALLBACK_REPO and calls == ["mlx-community/whisper-large-v3", FALLBACK_REPO]
