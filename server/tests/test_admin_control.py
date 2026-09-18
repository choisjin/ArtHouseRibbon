"""관리자 대시보드 조작: 호출 무시, 중단, 모두 멈춤"""
import asyncio

from ribbon.config import Settings
from ribbon.dialogue import DialogueManager
from ribbon.kids.registry import KidRegistry
from ribbon.protocol import KidInfo
from ribbon.providers.llm import MockLLM
from ribbon.providers.tts import BrowserTTS


def make(llm_delay=0.0):
    sent = []

    async def broadcast(m):
        sent.append(m)

    kids = KidRegistry([KidInfo(id="a", name="지우", mic_channel=0), KidInfo(id="b", name="민수", mic_channel=1)])
    dm = DialogueManager(Settings(), kids, MockLLM(llm_delay), BrowserTTS(), broadcast)

    async def fast_wait():
        # 재생 완료(tts.done)를 기다리지 않는다
        dm._pending_done.clear()
    dm._wait_spoken = fast_wait
    return dm, sent


async def test_ignore_calls_blocks_wake_but_admin_can_force():
    dm, _ = make()
    await dm.set_ignore_calls(True)
    await dm.on_wake(0)
    assert len(dm.queue) == 0
    await dm.on_wake(0, force=True)
    assert dm.queue.active() is not None
    assert dm.snapshot().ignore_calls is True


async def test_ignore_calls_drops_new_speech_without_turn():
    dm, _ = make()
    await dm.set_ignore_calls(True)
    await dm.on_utterance(1, "안녕")
    assert len(dm.queue) == 0


async def test_stop_cancels_thinking_and_moves_to_next():
    dm, sent = make(llm_delay=5.0)
    await dm.on_wake(0)
    await dm.on_wake(1)                          # 민수는 기다린다
    task = asyncio.create_task(dm.on_utterance(0, "그림 봐줘"))
    await asyncio.sleep(0.2)                     # LLM 이 생각하는 중
    assert dm._responding
    await dm.stop()
    assert task.done()
    assert {"type": "speak.stop"} in sent
    active = dm.queue.active()
    assert active is not None and active.kid_id == "b"


async def test_stop_all_clears_queue():
    dm, _ = make()
    await dm.on_wake(0)
    await dm.on_wake(1)
    await dm.stop(clear_queue=True)
    assert len(dm.queue) == 0
    assert dm.ribbon_state == "idle"


async def test_stop_drops_lines_waiting_to_be_spoken():
    """등원 인사를 말하는 동안 줄 서 있던 "말해봐"는 중단하면 말하지 않는다"""
    sent = []

    async def broadcast(m):
        sent.append(m)

    kids = KidRegistry([KidInfo(id="a", name="지우", mic_channel=0)])
    dm = DialogueManager(Settings(), kids, MockLLM(), BrowserTTS(), broadcast)   # 재생 완료를 진짜로 기다린다
    greet = asyncio.create_task(dm.on_kid_enter("a"))
    await asyncio.sleep(0.05)
    wake = asyncio.create_task(dm.on_wake(0))
    await asyncio.sleep(0.05)
    await dm.stop(clear_queue=True)
    await asyncio.wait_for(asyncio.gather(greet, wake), timeout=1.0)   # 기다리던 인사도 바로 풀린다
    spoken = [m["text"] for m in sent if m.get("type") == "speak"]
    assert len(spoken) == 1 and "왔구나" in spoken[0]


async def test_speaking_covers_speech_and_tail():
    dm, _ = make()
    assert not dm.speaking(now=1000.0)
    dm._pending_done.append(("u1", asyncio.Event(), 5))   # TV 가 아직 재생 중
    assert dm.speaking(now=1000.0)
    dm._pending_done.clear()
    t = dm._last_spoken_at = 1000.0              # 재생이 끝난 때
    assert dm.speaking(now=t + 0.3)              # 끝난 직후 여운
    assert not dm.speaking(now=t + dm.settings.echo_tail_ms / 1000 + 0.1)
