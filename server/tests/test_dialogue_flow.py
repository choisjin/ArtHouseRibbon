"""놀이 상대 대화 흐름: 부르면 띵, 이어 말한 뒷말을 버리지 않기"""
import asyncio

from ribbon.config import Settings
from ribbon.dialogue import DialogueManager
from ribbon.kids.registry import KidRegistry
from ribbon.protocol import KidInfo
from ribbon.providers.tts import BrowserTTS


class FakeLLM:
    """받은 아이 말을 기록하고, delay 뒤 한 문장으로 답한다"""

    def __init__(self, delay=0.0):
        self.delay = delay
        self.heard = []

    async def stream(self, messages):
        self.heard.append(messages[-1]["content"])
        await asyncio.sleep(self.delay)
        yield "그렇구나!"


def make(delay=0.0, on_spoken=None):
    sent = []

    async def broadcast(m):
        sent.append(m)

    kids = KidRegistry([KidInfo(id="a", name="지우", mic_channel=0)])
    llm = FakeLLM(delay)
    dm = DialogueManager(Settings(), kids, llm, BrowserTTS(), broadcast)

    async def fast_wait():
        dm._pending_done.clear()
        if on_spoken:
            on_spoken(dm)
    dm._wait_spoken = fast_wait
    return dm, sent, llm


def speaks(sent):
    return [m["text"] for m in sent if m.get("type") == "speak"]


async def test_wake_plays_cue_instead_of_talking():
    dm, sent, _ = make()
    await dm.on_wake(0)
    assert {"type": "cue", "kind": "listen", "kid_id": "a"} in sent
    assert speaks(sent) == []
    assert dm.speaking()                         # 띵 소리가 마이크로 들어가지 않게 잠깐


async def test_speech_continued_while_thinking_is_merged():
    dm, sent, llm = make(delay=0.3)
    await dm.on_wake(0)
    first = asyncio.create_task(dm.on_utterance(0, "나는 어제"))
    await asyncio.sleep(0.1)                     # 리본이가 생각하는 중에 이어 말한다
    await dm.on_utterance(0, "공룡을 봤어")
    await first
    assert llm.heard[-1] == "나는 어제 공룡을 봤어"
    assert speaks(sent) == ["그렇구나!"]         # 앞말에 대한 답은 버리고 한 번만 답한다
    assert dm.queue.active() is None


async def test_speech_while_speaking_is_answered_next_not_dropped():
    added = []

    def more_while_speaking(dm):
        if not added:
            added.append(1)
            dm.queue.add_text(0, "그리고 고양이도")   # 리본이가 말하는 사이 들어온 말
    dm, sent, llm = make(on_spoken=more_while_speaking)
    await dm.on_wake(0)
    await dm.on_utterance(0, "강아지 그렸어")
    assert llm.heard == ["강아지 그렸어", "그리고 고양이도"]
    assert dm.queue.active() is None


def test_old_settings_switch_to_play_partner_once(tmp_path):
    import json

    from ribbon.settings_store import ConfigStore
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"ribbon": {"ack_enabled": True, "max_sentences": 3}}), encoding="utf-8")
    rc = ConfigStore(p).config.ribbon
    assert rc.ack_enabled is False and rc.max_sentences == 2 and rc.listen_cue == "sound"
    # 옮긴 뒤 관리자가 다시 켠 것은 그대로 둔다
    p.write_text(json.dumps({"ribbon": {"ack_enabled": True, "max_sentences": 3, "dialogue_style": 2}}),
                 encoding="utf-8")
    rc = ConfigStore(p).config.ribbon
    assert rc.ack_enabled is True and rc.max_sentences == 3


async def test_own_voice_coming_back_is_ignored():
    dm, sent, llm = make()
    await dm.on_wake(0)
    await dm.on_utterance(0, "공룡 그렸어")         # 리본이 답: "그렇구나!"
    n = len(llm.heard)
    await dm.on_utterance(0, "그렇구나")            # 스피커 소리가 마이크로 다시 들어옴
    assert len(llm.heard) == n
    assert not [m for m in sent if m.get("type") == "transcript" and m["text"] == "그렇구나"]


async def test_woken_by_voice_takes_that_speech_without_cue():
    """마이크 말소리로 깨어나면 띵·말해봐 없이 (마이크를 막지 않고) 깨운 그 말에 바로 답한다"""
    dm, sent, llm = make()
    await dm.on_wake(0, by_voice=True)
    assert not [m for m in sent if m.get("type") in ("cue", "speak")]
    assert not dm.speaking()                      # 마이크를 막지 않는다
    await dm.on_utterance(0, "공룡 그렸어")         # 리본아 없이 바로
    assert llm.heard == ["공룡 그렸어"]


def test_old_default_game_range_moves_to_all_once(tmp_path):
    import json

    from ribbon.settings_store import ConfigStore
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"ribbon": {"game_max_id": 151, "dialogue_style": 2}}), encoding="utf-8")
    assert ConfigStore(p).config.ribbon.game_max_id == 1025          # 예전 기본값은 전체로
    p.write_text(json.dumps({"ribbon": {"game_max_id": 251, "dialogue_style": 2}}), encoding="utf-8")
    assert ConfigStore(p).config.ribbon.game_max_id == 251           # 관리자가 고른 값은 그대로
    p.write_text(json.dumps({"ribbon": {"game_max_id": 151, "game_range_v": 2, "dialogue_style": 2}}), encoding="utf-8")
    assert ConfigStore(p).config.ribbon.game_max_id == 151           # 옮긴 뒤 다시 151 로 고르면 그대로
