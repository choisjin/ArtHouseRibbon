"""리본이가 아이의 지적·금지를 약속으로 기억하기"""
import asyncio

from ribbon.config import Settings
from ribbon.dialogue import DialogueManager
from ribbon.kids.registry import KidRegistry
from ribbon.memory import MemoryStore, looks_like_correction, parse_changes, prompt_block
from ribbon.protocol import KidInfo
from ribbon.providers.tts import BrowserTTS


def test_store_caps_and_dedupes(tmp_path):
    m = MemoryStore(tmp_path / "memory.json", max_per_kid=2)
    assert m.add("지우를 공주님이라고 부르지 않는다.", "a")
    assert m.add("지우를 공주님이라고 부르지 않는다", "a") is None      # 같은 약속
    m.add("공룡 이야기를 먼저 꺼내지 않는다.", "a")
    m.add("천천히 말한다.", "a")                                       # 넘쳐서 제일 오래된 것이 빠진다
    assert [r.text for r in m.list("a")] == ["공룡 이야기를 먼저 꺼내지 않는다.", "천천히 말한다."]
    m.add("아이 그림을 놀리지 않는다.", None)
    assert len(m.for_kid("a")) == 3 and len(m.for_kid("b")) == 1       # 공통 약속은 모두에게
    again = MemoryStore(tmp_path / "memory.json")                        # 파일에 남는다
    assert len(again.rules) == 3


def test_cues_and_parse():
    assert looks_like_correction("나 공주 아니야 이름으로 불러줘")
    assert looks_like_correction("공룡 얘기 그만해")
    assert not looks_like_correction("오늘 공룡 그렸어")
    raw = '<think>음</think>{"add": ["지우를 준이라고 부른다.", "무서운 이야기를 해 준다."], "remove": ["ab12"]}'
    c = parse_changes(raw)
    assert c["add"] == ["지우를 준이라고 부른다."]                      # 안전 규칙을 푸는 약속은 버린다
    assert c["remove"] == ["ab12"]
    assert parse_changes('{"add": ["무서운 이야기를 하지 않는다."]}')["add"] == ["무서운 이야기를 하지 않는다."]
    assert parse_changes("모르겠어요") == {"add": [], "remove": []}


def test_prompt_block_puts_safety_first(tmp_path):
    m = MemoryStore(tmp_path / "memory.json")
    m.add("공룡 이야기를 먼저 꺼내지 않는다.", "a")
    block = prompt_block(m.for_kid("a"), "지우")
    assert "공룡 이야기" in block and "하지 말 것" in block
    assert prompt_block([], "지우") == ""


class ScriptLLM:
    """대화 답은 "알았어!", 약속 뽑기에는 정해 둔 JSON"""

    def __init__(self, extract_json):
        self.extract_json = extract_json
        self.systems = []

    async def stream(self, messages):
        self.systems.append(messages[0]["content"])
        if "약속을 뽑는 도우미" in messages[0]["content"]:
            yield self.extract_json
        else:
            yield "알았어!"


async def test_correction_is_learned_and_used_next_time(tmp_path):
    async def broadcast(m):
        sent.append(m)
    sent = []
    kids = KidRegistry([KidInfo(id="a", name="지우", mic_channel=0)])
    memory = MemoryStore(tmp_path / "memory.json")
    llm = ScriptLLM('{"add": ["지우를 공주님이라고 부르지 않는다."], "remove": []}')
    dm = DialogueManager(Settings(), kids, llm, BrowserTTS(), broadcast, memory=memory)

    async def fast_wait():
        dm._pending_done.clear()
    dm._wait_spoken = fast_wait

    await dm.on_wake(0)
    await dm.on_utterance(0, "나 공주님 아니야 그렇게 부르지 마")
    await asyncio.gather(*dm._bg)                                   # 뒤에서 약속 뽑기
    assert [r.text for r in memory.list("a")] == ["지우를 공주님이라고 부르지 않는다."]
    assert any(m.get("type") == "memory.changed" for m in sent)

    await dm.on_wake(0)
    await dm.on_utterance(0, "오늘 고양이 그렸어")
    assert "공주님이라고 부르지 않는다" in llm.systems[-1]            # 다음 대화 프롬프트에 들어간다
