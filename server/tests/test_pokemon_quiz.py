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
    assert dm.quiz.phase == "confirm"                    # 고른 걸 반짝이며 한 번 더 묻는다
    await dm.on_utterance(0, "응")
    assert dm.quiz.active and dm.quiz.phase == "playing"
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


def test_menu_pick_highlight_confirm(tmp_path):
    q = quiz(tmp_path)
    r = q.open_menu()
    v = q.view()
    assert v["kind"] == "menu" and v["selected"] is None and [i["num"] for i in v["items"]] == [1, 2, 3]
    q.handle("2번")
    assert q.view()["selected"] == "image" and q.phase == "confirm"
    q.handle("아니 가린 그림")                            # 다른 걸 고르면 그쪽이 반짝
    assert q.view()["selected"] == "peek"
    q.handle("다른 거 할래")                              # 싫다는 말 ("할래" 가 있어도)
    assert q.phase == "choosing" and q.view()["selected"] is None
    q.handle("설명 듣고 맞추기")
    r = q.handle("좋아")
    assert q.phase == "playing" and q.mode == "describe" and q.view()["kind"] == "play"


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
    assert dm.quiz.phase == "confirm" and dm.quiz.pending == "image"


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
    q.thumbs_dir = tmp_path / "game_thumbs"
    (tmp_path / "game_thumbs").mkdir()
    (tmp_path / "game_thumbs" / "image.png").write_bytes(b"png")
    q.open_menu()
    items = {i["mode"]: i for i in q.view()["items"]}
    assert items["image"]["thumb"] and items["describe"]["thumb"] is None
    assert items["peek"]["art"].endswith("/94/image")               # 팬텀
