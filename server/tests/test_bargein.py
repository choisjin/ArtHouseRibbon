"""끼어들기: 리본이가 말하는 중에 아이가 말하면 멈추고 그 말을 받는다"""
import asyncio

import numpy as np

from ribbon.audio.bargein import BargeIn
from ribbon.config import Settings
from ribbon.dialogue import DialogueManager
from ribbon.kids.registry import KidRegistry
from ribbon.protocol import KidInfo
from ribbon.providers.llm import MockLLM
from ribbon.providers.tts import BrowserTTS

ECHO = np.full(320, 800, dtype=np.int16)     # 스피커 소리가 마이크에 작게 (rms ~0.024)
VOICE = np.full(320, 4000, dtype=np.int16)   # 입 가까이 아이 목소리 (rms ~0.12)


def test_echo_does_not_trigger_but_voice_does():
    b = BargeIn()
    assert all(b.feed(ECHO, 0.06) is None for _ in range(100))
    assert 0.02 < b.peak < 0.03                    # 에코 크기를 알려 준다
    got = None
    for _ in range(20):
        got = got or b.feed(VOICE, 0.06)
    assert got is not None and len(got) <= 25        # 0.5초 안쪽만 넘긴다 (리본이 목소리가 덜 섞이게)
    assert b.end() < 0.03                            # 끼어든 소리는 에코 크기에 넣지 않는다


def test_short_bump_is_not_barge_in():
    b = BargeIn()
    frames = [VOICE] * 5 + [ECHO] * 20              # 0.1초 쿵
    assert all(b.feed(f, 0.06) is None for f in frames)


async def test_barge_in_stops_ribbon_and_opens_mic():
    sent = []

    async def broadcast(m):
        sent.append(m)
    kids = KidRegistry([KidInfo(id="a", name="지우", mic_channel=0)])
    dm = DialogueManager(Settings(), kids, MockLLM(5.0), BrowserTTS(), broadcast)

    async def fast_wait():
        dm._pending_done.clear()
    dm._wait_spoken = fast_wait
    await dm.on_wake(0)
    task = asyncio.create_task(dm.on_utterance(0, "공룡 이야기 해 줘"))
    await asyncio.sleep(0.1)
    assert dm._responding
    dm.note_barge_in()
    assert not dm.speaking()                         # 바로 다음 소리 조각부터 마이크를 막지 않는다
    await dm.barge_in(0)
    await asyncio.sleep(0)
    assert task.done() and not dm._responding
    assert {"type": "speak.stop"} in sent and not dm.speaking()
