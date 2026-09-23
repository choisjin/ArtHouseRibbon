"""DJI 호출 버튼: 누가 눌렀는지 몰라서 먼저 말한 채널이 부른 아이"""
import asyncio

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

    async def fast_wait():
        dm._pending_done.clear()
    dm._wait_spoken = fast_wait
    await dm.on_button([0, 1])
    assert {"type": "button", "channels": [0, 1]} in sent
    await dm.claim(1)
    active = dm.queue.active()
    assert active is not None and active.kid_id == "b"
    assert dm.ribbon_state == "listening"
    assert not [m for m in sent if m.get("type") == "speak"]                   # 버튼을 눌러도 말하지 않는다 (마이크 표시만)


async def test_fillers_are_synthesized_ahead():
    calls = []

    class CountTTS:
        async def synthesize(self, text):
            calls.append(text)
            return b"RIFF"

    async def broadcast(m):
        pass
    dm = DialogueManager(Settings(), KidRegistry([]), MockLLM(), CountTTS(), broadcast)

    async def fast_wait():
        dm._pending_done.clear()
    dm._wait_spoken = fast_wait
    await dm.prewarm()
    n = calls.count("음...")
    await dm._say("음...", None, final=True)
    await dm._say("음...", None, final=True)
    assert n == 1 and calls.count("음...") == 1                                 # 미리 만든 소리를 다시 쓴다


def test_button_mode_takes_one_utterance_then_closes():
    p = procs()
    proc = p[0]
    proc.single_shot = True
    proc.start_listening(now=100.0, window_s=6)
    events = []
    t = 100.0
    for f in [LOUD] * 25 + [QUIET] * 80:            # 0.5초 말하고 1.6초 조용
        t += 0.02
        events += proc.feed(f, now=t)
    assert [k for k, _ in events] == ["utterance"]
    assert proc.state == "idle"                      # 이어 말하기를 기다리지 않는다


def test_button_mode_does_not_wake_by_voice():
    s = Settings()
    s.wakeword_provider = "energy"
    proc = ChannelProcessor(0, s, make_wakeword(s))
    proc.voice_wake = False
    assert all(proc.feed(LOUD, now=100.0 + i * 0.02) == [] for i in range(50))
    assert proc.state == "idle"


def test_cancel_stops_waiting():
    """버튼을 한 번 더 누르면 기다리기를 그만둔다 (2026-09-21)"""
    p = procs()
    bc = ButtonCall(p)
    bc.press([0, 1], 6.0)
    assert bc.armed == [0, 1]
    bc.cancel()
    assert bc.armed == [] and all(pr.state == "idle" for pr in p.values())


async def test_button_while_talking_ends_conversation():
    """말하는 중에 버튼을 한 번 더: 남은 말을 버리고 짧게 인사하며 대화를 마무리한다 (2026-09-23 요청)"""
    from test_dialogue_flow import make, speaks

    dm, sent, llm = make()
    await dm.on_wake(0)
    dm._pending_done = [("u1", asyncio.Event(), 5, "남은 말이야."), ("u2", asyncio.Event(), 4, "또 있어.")]
    dm.target_kid = "a"
    assert dm.in_conversation()
    await dm.end_by_button()
    assert any(m.get("type") == "speak.stop" for m in sent)        # TV 는 하던 소리를 버린다
    assert speaks(sent)[-1] == "응, 그럼 다음에 또 이야기하자!"
    assert "남은 말이야." not in speaks(sent)                        # 남은 말은 하지 않는다
    assert dm.queue.active() is None and dm.ribbon_state == "idle"
    assert not dm.in_conversation()


async def test_button_while_listening_ends_conversation():
    """듣는 중(차례가 열려 있음)에 버튼을 한 번 더 누르면 대화를 마무리한다"""
    from test_dialogue_flow import make, speaks

    dm, sent, _ = make()
    await dm.on_wake(0)
    assert dm.queue.active() is not None and dm.in_conversation()
    await dm.end_by_button()
    assert dm.queue.active() is None and dm.ribbon_state == "idle"
    assert speaks(sent)[-1] == "응, 그럼 다음에 또 이야기하자!"


async def test_not_in_conversation_when_idle():
    from test_dialogue_flow import make

    dm, _sent, _ = make()
    assert not dm.in_conversation()
