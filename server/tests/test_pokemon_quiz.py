"""포켓몬 맞추기 게임: 한국어 이름 기준, 힌트는 달라고 할 때만"""
import json
import random

from ribbon.config import Settings
from ribbon.dialogue import DialogueManager
from ribbon.games.pokemon_quiz import PokemonQuiz, detect_start, iya
from ribbon.kids.registry import KidRegistry
from ribbon.knowledge.pokedex import Pokedex
from ribbon.protocol import KidInfo
from ribbon.providers.tts import BrowserTTS

MINI = [
    {"id": 25, "name": "피카츄", "genus": "쥐포켓몬", "types": ["전기"], "height_m": 0.4, "weight_kg": 6.0,
     "evolution": "피츄(친해지면) → 피카츄 → 라이츄(천둥의돌)", "flavor": ["피카츄는 뺨에 전기 주머니가 있다.", "꼬리를 세운다."]},
]


def quiz(tmp_path, entries=MINI):
    p = tmp_path / "pokedex.json"
    p.write_text(json.dumps({"pokemon": entries}, ensure_ascii=False), encoding="utf-8")
    return PokemonQuiz(Pokedex(p), random.Random(1))


def test_start_phrases():
    assert detect_start("포켓몬 맞추기 하자") == ""
    assert detect_start("포켓몬 그림 보고 맞추기") == "image"
    assert detect_start("가린 포켓몬 맞추기 게임") == "peek"
    assert detect_start("포켓몬 설명 퀴즈") == "describe"
    assert detect_start("피카츄 좋아") is None


def test_wrong_answer_gives_no_hint(tmp_path):
    q = quiz(tmp_path)
    q.start("image")
    before = list(q.hints)
    r = q.handle("라이츄")
    assert "아니야" in r.lines[0] and "힌트" not in " ".join(r.lines)
    assert q.hints == before and q.view()["board"] == []


def test_image_hints_count_then_chosung_then_letters(tmp_path):
    q = quiz(tmp_path)
    q.start("image")
    assert "세 글자" in q.handle("힌트").lines[0]
    assert [b["c"] for b in q.view()["board"]] == ["", "", ""]
    assert "피읖" in q.handle("모르겠어").lines[0]
    assert [b["c"] for b in q.view()["board"]] == ["ㅍ", "ㅋ", "ㅊ"]
    assert "'피'" in q.handle("힌트 줘").lines[0]
    assert [b["c"] for b in q.view()["board"]] == ["피", "ㅋ", "ㅊ"]


def test_fuzzy_correct_answer_and_again(tmp_path):
    q = quiz(tmp_path)
    q.start("image")
    r = q.handle("피카추야")                         # 음성 인식이 조금 틀려도 정답
    assert r.lines[0] == "딩동댕! 정답은 피카츄야!" and q.view()["answer"] == "피카츄"
    assert q.handle("응 또 할래").new_round
    assert q.handle("그만할래").ended and not q.active


def test_peek_reveals_scattered_tiles(tmp_path):
    q = quiz(tmp_path)
    q.start("peek")
    assert len(q.view()["shown"]) == 4                # 36칸 중 4칸만
    q.handle("힌트")
    shown = q.view()["shown"]
    assert len(shown) == 9 and len(set(shown)) == 9


def test_describe_hints_hide_the_name(tmp_path):
    q = quiz(tmp_path)
    r = q.start("describe")
    assert "전기 타입" in r.lines[-1] and q.view()["image"] is None
    lines = [q.handle("힌트").lines[0] for _ in range(4)]
    assert all("피카츄" not in l for l in lines)
    assert any("이 포켓몬" in l for l in lines)       # 도감 문장 속 이름은 가린다


def test_particles():
    assert iya("리자몽") == "리자몽이야" and iya("피카츄") == "피카츄야"


async def test_dialogue_plays_without_llm(tmp_path):
    sent = []

    async def broadcast(m):
        sent.append(m)

    class NoLLM:
        async def stream(self, messages):
            raise AssertionError("게임 답은 대화 모델을 거치지 않는다")
            yield ""

    p = tmp_path / "pokedex.json"
    p.write_text(json.dumps({"pokemon": MINI}, ensure_ascii=False), encoding="utf-8")
    kids = KidRegistry([KidInfo(id="a", name="지우", mic_channel=0), KidInfo(id="b", name="민수", mic_channel=1)])
    dm = DialogueManager(Settings(), kids, NoLLM(), BrowserTTS(), broadcast, pokedex=Pokedex(p))

    async def fast_wait():
        dm._pending_done.clear()
    dm._wait_spoken = fast_wait
    await dm.on_wake(0)
    await dm.on_utterance(0, "포켓몬 그림 보고 맞추기 하자")
    assert dm.quiz.active and any(m.get("type") == "game" and m["view"] for m in sent)
    await dm.on_utterance(1, "피카츄!")                  # 다른 아이가 맞혀도 된다
    speaks = [m["text"] for m in sent if m.get("type") == "speak"]
    assert "딩동댕! 정답은 피카츄야!" in speaks
    await dm.on_utterance(1, "그만")
    assert not dm.quiz.active
    assert any(m.get("type") == "game" and m["view"] is None for m in sent)   # TV 게임 화면을 닫는다


def test_start_phrases_with_speech_recognition_slips():
    for t in ["포캣몬 맞추기 하자", "포켓몬 마추기 하자", "포켓몬 퀴즈 내줘", "포켓몬 게임 하자!", "포켓몬 이름 맞히기"]:
        assert detect_start(t) is not None, t


async def test_no_pokedex_says_so_instead_of_chatting(tmp_path):
    sent = []

    async def broadcast(m):
        sent.append(m)

    class NoLLM:
        async def stream(self, messages):
            raise AssertionError("게임 하자는 말은 대화 모델로 넘기지 않는다")
            yield ""

    kids = KidRegistry([KidInfo(id="a", name="지우", mic_channel=0)])
    dm = DialogueManager(Settings(), kids, NoLLM(), BrowserTTS(), broadcast,
                         pokedex=Pokedex(tmp_path / "없음.json"))

    async def fast_wait():
        dm._pending_done.clear()
    dm._wait_spoken = fast_wait
    await dm.on_wake(0)
    await dm.on_utterance(0, "포켓몬 맞추기 하자")
    speaks = [m["text"] for m in sent if m.get("type") == "speak"]
    assert "도감이 아직 없어서" in speaks[-1]
    assert dm.queue.active() is None
