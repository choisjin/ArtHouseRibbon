"""음성 취소와 호출 버튼으로 대화 멈추기"""
import asyncio

from ribbon.config import Settings
from ribbon.dialogue import DialogueManager
from ribbon.kids.registry import KidRegistry
from ribbon.persona.ribbon import is_cancel
from ribbon.protocol import KidInfo
from ribbon.providers.llm import MockLLM
from ribbon.providers.tts import BrowserTTS


def test_cancel_phrases():
    for t in ["취소", "취소할게", "나중에 할게", "아 나중에 할래요", "리본아 됐어", "됐어 됐어", "안 할래",
              "아니야 아무것도 아니야", "잘못 불렀어", "이제 그만", "할 말 없어", "다음에 할게"]:
        assert is_cancel(t, names=("리본",)), t


def test_not_cancel_when_it_is_real_talk():
    for t in ["공룡 얘기 그만해", "고양이 없어", "다음에 뭐 그릴까", "내가 잘못 그렸어", "나중에 커서 화가 될래",
              "오늘 그림 다 그렸어"]:
        assert not is_cancel(t, names=("리본",)), t


def make(llm_delay=0.0):
    sent = []

    async def broadcast(m):
        sent.append(m)
    kids = KidRegistry([KidInfo(id="a", name="지우", mic_channel=0), KidInfo(id="b", name="민수", mic_channel=1)])
    dm = DialogueManager(Settings(), kids, MockLLM(llm_delay), BrowserTTS(), broadcast)

    async def fast_wait():
        dm._pending_done.clear()
    dm._wait_spoken = fast_wait
    return dm, sent


async def test_voice_cancel_stops_answer_in_progress():
    dm, sent = make(llm_delay=5.0)
    await dm.on_wake(0)
    thinking = asyncio.create_task(dm.on_utterance(0, "그림 이야기 해줘"))
    await asyncio.sleep(0.1)
    assert dm._responding
    await dm.on_utterance(0, "아 나중에 할게")
    await asyncio.sleep(0)
    assert thinking.done() and not dm._responding
    assert dm.queue.active() is None
    speaks = [m["text"] for m in sent if m.get("type") == "speak"]
    assert speaks[-1].endswith("나중에 또 불러줘.")


async def test_button_resets_conversation_and_queue():
    dm, sent = make(llm_delay=5.0)
    await dm.on_wake(0)
    await dm.on_wake(1)                               # 민수는 기다리는 중
    thinking = asyncio.create_task(dm.on_utterance(0, "공룡 그렸어"))
    await asyncio.sleep(0.1)
    await dm.reset_for_button()
    await asyncio.sleep(0)
    assert thinking.done() and len(dm.queue) == 0
    assert {"type": "speak.stop"} in sent
    await dm.on_button([0, 1])
    assert dm.ribbon_state == "listening"
