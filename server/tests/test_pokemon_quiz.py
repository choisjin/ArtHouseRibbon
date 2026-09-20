"""포켓몬 맞추기 게임: 한국어 이름 기준, 힌트는 달라고 할 때만"""
import json
import random

import pytest

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


def test_fuzzy_correct_answer_goes_on_to_the_next_question(tmp_path):
    q = quiz(tmp_path)
    q.start("image")
    r = q.handle("피카추야")                         # 음성 인식이 조금 틀려도 정답
    assert r.lines[0] == "딩동댕! 정답은 피카츄야!" and q.view()["answer"] == "피카츄"
    assert r.auto_next and "할래" not in " ".join(r.lines)   # 묻지 않고 (dialogue 가 잠깐 쉬고 다음 문제)
    nxt = q.next_round()
    assert nxt.new_round and nxt.lines[0].startswith("다음 문제!") and not q.view()["answer"]
    assert q.handle("그만할래").ended and not q.active


def test_stop_while_showing_the_answer(tmp_path):
    q = quiz(tmp_path)
    q.start("image")
    assert q.handle("피카츄").auto_next
    assert q.phase == "revealed"
    assert q.handle("이제 그만할래").ended and not q.active   # 정답 보여 주는 사이에도 그만할 수 있다


def test_give_up_and_pass_also_continue(tmp_path):
    q = quiz(tmp_path)
    q.start("image")
    assert q.handle("정답 알려줘").auto_next
    q.next_round()
    assert q.handle("다음 문제").auto_next


MANY = MINI + [
    {"id": 635, "name": "삼삼드래", "genus": "난폭포켓몬", "types": ["악"], "height_m": 1.8, "weight_kg": 160.0},
    {"id": 43, "name": "뚜벅쵸", "genus": "잡초포켓몬", "types": ["풀"], "height_m": 0.5, "weight_kg": 5.4},
    {"id": 6, "name": "리자몽", "genus": "화염포켓몬", "types": ["불꽃"], "height_m": 1.7, "weight_kg": 90.5},
]


@pytest.mark.parametrize("answer,heard,ok", [
    ("삼삼드래", "삼삼드래", True),
    ("삼삼드래", "33드래", True),          # 숫자로 적힌 경우
    ("삼삼드래", "삼삼드레", True),
    ("삼삼드래", "samsamdrae", True),      # 영어로 적힌 경우
    ("삼삼드래", "리자몽", False),
    ("뚜벅쵸", "두벅초", True),            # 쌍자음·거센소리를 못 들은 경우
    ("뚜벅쵸", "ddubeokcho", True),
    ("뚜벅쵸", "리자몽", False),
    ("피카츄", "피가츄", True),
    ("피카츄", "pikachu", True),
    ("피카츄", "핑구", False),
])
def test_misheard_names_still_count(tmp_path, answer, heard, ok):
    q = quiz(tmp_path, MANY)
    q.start("image")
    q.answer = next(e for e in MANY if e["name"] == answer)
    assert q.is_correct(heard) is ok


def test_stt_words_include_the_answer_among_others(tmp_path):
    """음성 인식에 포켓몬 이름을 미리 알려 준다 (정답 하나만 넣으면 그 이름을 지어낼 수 있어 섞어서)"""
    q = quiz(tmp_path, MANY)
    assert q.stt_words() == []                     # 게임 중이 아니면 없다
    q.start("image")
    words = q.stt_words(3)
    assert q.answer["name"] in words and len(words) == 3
    assert len(set(words)) == 3


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


async def test_dialogue_plays_without_llm(tmp_path, monkeypatch):
    import ribbon.dialogue as dialogue_mod
    monkeypatch.setattr(dialogue_mod, "QUIZ_NEXT_DELAY_S", 0.01)   # 다음 문제까지 쉬는 시간 (시험에서는 짧게)
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
    assert dm.quiz.active and dm.quiz.phase == "playing"   # 콕 집어 말하면 바로 시작
    await dm.on_utterance(1, "피카츄!")                  # 다른 아이가 맞혀도 된다
    speaks = [m["text"] for m in sent if m.get("type") == "speak"]
    assert "딩동댕! 정답은 피카츄야!" in speaks
    # 묻지 않고 다음 문제로 (그만할 때까지). 정답 그림을 잠깐 보여 준 뒤에 낸다
    assert dm.quiz.phase == "playing" and not dm.quiz.solved
    speaks = [m["text"] for m in sent if m.get("type") == "speak"]
    assert speaks[-1].startswith("다음 문제!")
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


def test_menu_pick_starts_right_away(tmp_path):
    """번호 없이 게임 이름만 보여 주고, 고르면 묻지 않고 바로 시작 (2026-09-21 요청)"""
    q = quiz(tmp_path)
    r = q.open_menu()
    v = q.view()
    assert v["kind"] == "menu" and [i["mode"] for i in v["items"]] == ["describe", "image", "peek"]
    assert all("num" not in i for i in v["items"])
    assert "1번" not in " ".join(r.lines) and "설명 듣고 맞추기" in " ".join(r.lines)
    r = q.handle("그림 보고 맞추기")
    assert q.phase == "playing" and q.mode == "image" and q.view()["kind"] == "play"
    assert "시작" in r.lines[0]


def test_menu_can_be_opened_with_a_game_name(tmp_path):
    q = quiz(tmp_path)
    q.open_menu("peek")                                  # 콕 집어 말하면 바로 그 게임으로
    assert q.phase == "playing" and q.mode == "peek"


async def test_menu_answer_repeating_ribbon_is_not_echo(tmp_path):
    """리본이가 읽어 준 게임 이름을 아이가 따라 말해도 에코로 버리지 않는다"""
    sent = []

    async def broadcast(m):
        sent.append(m)
    p = tmp_path / "pokedex.json"
    p.write_text(json.dumps({"pokemon": MINI}, ensure_ascii=False), encoding="utf-8")
    kids = KidRegistry([KidInfo(id="a", name="지우", mic_channel=0)])
    dm = DialogueManager(Settings(), kids, None, BrowserTTS(), broadcast, pokedex=Pokedex(p))

    async def fast_wait():
        dm._pending_done.clear()
    dm._wait_spoken = fast_wait
    await dm.on_wake(0)
    await dm.on_utterance(0, "포켓몬 맞추기 하자")        # 리본: "... 2번 그림 보고 맞추기 ..."
    await dm.on_utterance(0, "그림 보고 맞추기")
    assert dm.quiz.phase == "playing" and dm.quiz.mode == "image"


def test_play_words_open_the_game():
    for t in ["게임하자", "놀이하자", "놀아줘", "리본아 놀자", "심심해", "뭐 하고 놀까?", "퀴즈 내줘", "게임!",
              "재밌는 거 하자", "맞추기 게임 할래", "그림 맞추기 하자"]:
        assert detect_start(t) is not None, t
    assert detect_start("그림 맞추기 하자") == "image"


def test_stories_about_play_do_not_open_the_game():
    for t in ["친구랑 게임했어", "놀이터 갔었어", "어제 친구랑 놀았어", "놀이공원 가고 싶어", "오늘 그림 그렸어"]:
        assert detect_start(t) is None, t


def test_saying_no_on_menu_goes_back_to_chat(tmp_path):
    q = quiz(tmp_path)
    q.open_menu()
    r = q.handle("아니 소꿉놀이 하자")
    assert r.passthrough and not q.active


def test_yes_no_words():
    from ribbon.games.pokemon_quiz import _is_no, _is_yes
    for t in ["응", "어", "웅", "네", "예", "넵", "그래", "좋아", "좋지!", "콜", "오케이", "할래", "하자", "해 줘",
              "당연하지", "물론이지", "고고", "가자", "시작해", "알았어", "그럼!", "재밌겠다", "응 할래"]:
        assert _is_yes(t) and not _is_no(t), t
    for t in ["아니", "아니야", "아냐", "아뇨", "싫어", "안 해", "안 할래", "됐어", "괜찮아", "노", "별로",
              "그만", "다음에", "나중에 할래", "안 좋아", "다른 거 하자"]:
        assert _is_no(t) and not _is_yes(t), t
    for t in ["어제 공룡 그렸어", "이거 뭐야?", "고양이"]:
        assert not _is_yes(t) and not _is_no(t), t


def test_play_word_asks_before_opening(tmp_path):
    q = quiz(tmp_path)
    r = q.offer()
    assert r.lines == ["포켓몬 맞추기 할까?"] and q.view() is None       # 아직 화면을 열지 않는다
    q.handle("좋아!")
    assert q.phase == "choosing" and q.view()["kind"] == "menu"


def test_offer_declined(tmp_path):
    q = quiz(tmp_path)
    q.offer()
    r = q.handle("싫어")
    assert r.lines == ["알겠어!"] and r.ended and not q.active
    q.offer()
    r = q.handle("아니 소꿉놀이 하자")                                   # 다른 놀이는 대화로
    assert r.passthrough and not q.active
    q.offer()
    assert q.handle("오늘 비 와").passthrough                            # 딴 이야기도 대화로


async def test_dialogue_asks_for_play_words_not_for_explicit(tmp_path):
    sent = []

    async def broadcast(m):
        sent.append(m)
    p = tmp_path / "pokedex.json"
    p.write_text(json.dumps({"pokemon": MINI}, ensure_ascii=False), encoding="utf-8")
    kids = KidRegistry([KidInfo(id="a", name="지우", mic_channel=0)])
    dm = DialogueManager(Settings(), kids, None, BrowserTTS(), broadcast, pokedex=Pokedex(p))

    async def fast_wait():
        dm._pending_done.clear()
    dm._wait_spoken = fast_wait
    await dm.on_utterance(0, "심심해 놀아줘")
    assert dm.quiz.phase == "offer"
    await dm.on_utterance(0, "응")
    assert dm.quiz.phase == "choosing"
    await dm.on_utterance(0, "그만")
    await dm.on_utterance(0, "포켓몬 맞추기 하자")
    assert dm.quiz.phase == "choosing"                                  # 콕 집어 말하면 다시 묻지 않는다


def test_new_game_names():
    from ribbon.games.pokemon_quiz import MODE_NAME, detect_mode
    assert MODE_NAME["peek"] == "조금 보고 맞추기"
    assert detect_mode("조금 보고 맞추기") == "peek"          # "보고" 가 있어도 2번이 아니라 3번
    assert detect_mode("조금만 보여 줘") == "peek"
    assert detect_mode("그림 보고 맞추기") == "image"
    assert detect_mode("설명 듣고 맞추기") == "describe"
    assert detect_mode("3번") == "peek" and detect_mode("2번") == "image" and detect_mode("1번") == "describe"


def test_menu_items_have_art_and_thumb_only_if_made(tmp_path):
    q = quiz(tmp_path)
    q.thumbs_dirs = [tmp_path / "game_thumbs", tmp_path / "dist"]
    (tmp_path / "game_thumbs").mkdir()
    (tmp_path / "dist").mkdir()
    (tmp_path / "game_thumbs" / "image.png").write_bytes(b"png")
    (tmp_path / "dist" / "peek.jpg").write_bytes(b"jpg")                 # 저장소에 넣어 둔 표지
    q.open_menu()
    items = {i["mode"]: i for i in q.view()["items"]}
    assert items["image"]["thumb"] and items["peek"]["thumb"] and items["describe"]["thumb"] is None
    assert q.thumb_file("peek").suffix == ".jpg"
    assert items["peek"]["art"].endswith("/94/image")               # 팬텀


def test_describe_first_question_is_rich(tmp_path):
    entry = dict(MINI[0], look=["온몸이 노란색이야.", "통통한 몸을 가졌어.", "볼에 빨간 동그라미가 있어.", "번개 모양 꼬리가 있어."])
    q = quiz(tmp_path, [entry])
    r = q.start("describe")
    first = r.lines[-1]
    assert "전기 타입" in first and "쥐포켓몬이라고 불려" in first
    assert "온몸이 노란색이야." in first and "통통한 몸을 가졌어." in first and first.endswith("누구일까?")
    assert "피카츄" not in first
    assert q.handle("힌트").lines[0] == "힌트! 볼에 빨간 동그라미가 있어."      # 나머지 생김새가 먼저
    assert q.handle("힌트").lines[0] == "힌트! 번개 모양 꼬리가 있어."


def test_clean_look_drops_name_and_numbers():
    from ribbon.knowledge.pokedex import clean_look
    raw = "1. 온몸이 노란색이야\n- 피카츄는 귀엽다.\n\n• 볼이 빨개."
    assert clean_look(raw, "피카츄") == ["온몸이 노란색이야.", "볼이 빨개."]


def test_pokedex_loads_and_saves_looks(tmp_path):
    p = tmp_path / "pokedex.json"
    p.write_text(json.dumps({"pokemon": MINI}, ensure_ascii=False), encoding="utf-8")
    cache = tmp_path / "looks_cache.json"
    d = Pokedex(p, cache)
    d.save_look(25, ["노란색이야.", "통통해."])
    again = Pokedex(p, cache)
    assert again.find("피카츄")[0]["look"] == ["노란색이야.", "통통해."]


def test_type_particles():
    from ribbon.games.pokemon_quiz import _with_rang
    assert _with_rang(["고스트", "독"]) == "고스트랑 독"
    assert _with_rang(["풀", "독"]) == "풀이랑 독"
    assert _with_rang(["전기"]) == "전기"
