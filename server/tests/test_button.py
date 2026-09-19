"""DJI 호출 버튼: 누가 눌렀는지 몰라서 먼저 말한 채널이 부른 아이"""
import numpy as np

from ribbon.audio.button import ButtonCall
from ribbon.audio.stream import ChannelProcessor
from ribbon.audio.wakeword import make_wakeword
from ribbon.config import Settings
from ribbon.dialogue import DialogueManager
from ribbon.kids.registry import KidRegistry
from ribbon.protocol import KidInfo
from ribbon.providers.llm import MockLLM
from ribbon.providers.tts import BrowserTTS

LOUD = np.full(320, 3000, dtype=np.int16)
QUIET = np.zeros(320, dtype=np.int16)


def procs():
    s = Settings()
    return {ch: ChannelProcessor(ch, s, make_wakeword(s)) for ch in range(4)}


def test_first_channel_to_speak_wins_and_others_stop():
    p = procs()
    bc = ButtonCall(p)
    assert bc.press([0, 1], window_s=6, now=100.0) == [0, 1]
    assert p[0].state == p[1].state == "listening" and p[2].state == "idle"   # 아이가 없는 채널은 안 듣는다
    p[0].feed(QUIET, now=100.1)
    assert bc.check(0, now=100.1) is None
    p[1].feed(LOUD, now=100.2)                       # 1번 채널이 먼저 말을 시작
    assert bc.check(1, now=100.2) == 1
    assert p[0].state == "idle" and p[1].state == "listening"
    assert bc.check(0, now=100.3) is None            # 한 번 고르면 끝


def test_nobody_speaks_then_it_just_ends():
    p = procs()
    bc = ButtonCall(p)
    bc.press([0], window_s=2, now=100.0)
    assert bc.check(0, now=103.0) is None and bc.armed == []


def test_busy_channel_is_not_rearmed():
    p = procs()
    p[0].start_listening(now=100.0)                   # 이미 대화 중인 채널
    bc = ButtonCall(p)
    assert bc.press([0, 1], window_s=6, now=100.0) == [1]


async def test_claim_gives_turn_without_talking():
    sent = []

    async def broadcast(m):
        sent.append(m)
    kids = KidRegistry([KidInfo(id="a", name="지우", mic_channel=0), KidInfo(id="b", name="민수", mic_channel=1)])
    dm = DialogueManager(Settings(), kids, MockLLM(), BrowserTTS(), broadcast)
    await dm.on_button([0, 1])
    assert {"type": "cue", "kind": "listen", "kid_id": None} in sent
    await dm.claim(1)
    active = dm.queue.active()
    assert active is not None and active.kid_id == "b"
    assert dm.ribbon_state == "listening"
    assert not [m for m in sent if m.get("type") == "speak"]
