"""포켓몬 도감: 아이 말에서 포켓몬 찾기, 대화 모델에 참고 자료로 넣기"""
import json

from ribbon.config import Settings
from ribbon.dialogue import DialogueManager
from ribbon.kids.registry import KidRegistry
from ribbon.knowledge.pokedex import Pokedex, knowledge_block
from ribbon.protocol import KidInfo
from ribbon.providers.tts import BrowserTTS

MINI = [
    {"id": 25, "name": "피카츄", "genus": "쥐포켓몬", "types": ["전기"], "height_m": 0.4, "weight_kg": 6.0,
     "evolution": "피츄(친해지면) → 피카츄 → 라이츄(천둥의돌)", "flavor": ["뺨에 전기 주머니가 있다."]},
    {"id": 6, "name": "리자몽", "genus": "화염포켓몬", "types": ["불꽃", "비행"], "height_m": 1.7, "weight_kg": 90.5,
     "evolution": "파이리 → 리자드(레벨 16) → 리자몽(레벨 36)", "flavor": []},
    {"id": 150, "name": "뮤츠", "genus": "유전포켓몬", "types": ["에스퍼"], "height_m": 2.0, "weight_kg": 122.0,
     "legendary": True, "evolution": "뮤츠", "flavor": []},
    {"id": 151, "name": "뮤", "genus": "신종포켓몬", "types": ["에스퍼"], "height_m": 0.4, "weight_kg": 4.0,
     "legendary": True, "evolution": "뮤", "flavor": []},
    {"id": 99, "name": "킹크랩", "genus": "집게포켓몬", "types": ["물"], "height_m": 1.3, "weight_kg": 60.0,
     "evolution": "크랩 → 킹크랩(레벨 28)", "flavor": []},
]


def dex(tmp_path):
    p = tmp_path / "pokedex.json"
    p.write_text(json.dumps({"pokemon": MINI}, ensure_ascii=False), encoding="utf-8")
    return Pokedex(p)


def names(found):
    return [e["name"] for e in found]


def test_find_exact_fuzzy_and_not_everyday(tmp_path):
    d = dex(tmp_path)
    assert names(d.find("피카츄는 어떻게 진화해?")) == ["피카츄"]
    assert names(d.find("피카추 좋아")) == ["피카츄"]                    # 음성 인식이 조금 틀려도
    assert names(d.find("리자몽이랑 뮤츠 누가 세?")) == ["리자몽", "뮤츠"]
    assert names(d.find("뮤 알아?")) == ["뮤"]                          # 한 글자 이름은 따로 떨어져 있을 때만
    assert names(d.find("오늘 나무 그렸어")) == []
    assert names(d.find("어제 킹크랩 먹었어")) == []                     # 일상에서 쓰는 말
    assert names(d.find("포켓몬 킹크랩 알아?")) == ["킹크랩"]


def test_missing_file_is_empty(tmp_path):
    assert len(Pokedex(tmp_path / "없음.json")) == 0


def test_block_has_facts_and_no_invent_rule(tmp_path):
    b = knowledge_block(dex(tmp_path).find("피카츄"))
    assert "라이츄(천둥의돌)" in b and "지어내지" in b


class RecLLM:
    def __init__(self):
        self.systems = []

    async def stream(self, messages):
        self.systems.append(messages[0]["content"])
        yield "좋아!"


async def test_dialogue_passes_pokedex_and_remembers_for_follow_up(tmp_path):
    async def broadcast(m):
        pass
    kids = KidRegistry([KidInfo(id="a", name="지우", mic_channel=0)])
    llm = RecLLM()
    dm = DialogueManager(Settings(), kids, llm, BrowserTTS(), broadcast, pokedex=dex(tmp_path))

    async def fast_wait():
        dm._pending_done.clear()
    dm._wait_spoken = fast_wait
    await dm.on_wake(0)
    await dm.on_utterance(0, "피카츄는 어떻게 진화해?")
    assert "천둥의돌" in llm.systems[-1]
    await dm.on_wake(0)
    await dm.on_utterance(0, "걔는 뭐 먹어?")                           # 이어지는 질문
    assert "피카츄" in llm.systems[-1]
