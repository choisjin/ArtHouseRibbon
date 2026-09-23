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


async def test_button_while_talking_cuts_speech_and_listens_again():
    """말하는 중에 버튼: 말을 끊고 묻지 않고 바로 새로 듣는다 (2026-09-23 요청, main._on_button 의 순서)"""
    from test_dialogue_flow import make, speaks

    dm, sent, _ = make()
    await dm.on_wake(0)
    dm._pending_done = [("u1", asyncio.Event(), 5, "남은 말이야."), ("u2", asyncio.Event(), 4, "또 있어.")]
    assert dm.talking()
    before = len(speaks(sent))
    await dm.reset_for_button()
    await dm.on_button([0])
    assert any(m.get("type") == "speak.stop" for m in sent)        # TV 는 하던 소리와 남은 문장을 버린다
    assert len(speaks(sent)) == before                             # "이어서 말할까?" 같은 말을 하지 않는다
    assert not dm.talking() and dm.ribbon_state == "listening"


async def test_button_while_listening_cancels_input():
    """듣는 중에 버튼을 한 번 더 누르면 이번 입력을 취소한다"""
    from test_dialogue_flow import make, speaks

    dm, sent, _ = make()
    await dm.on_wake(0)
    assert dm.queue.active() is not None
    before = len(speaks(sent))
    await dm.cancel_listening()
    assert dm.queue.active() is None and dm.ribbon_state == "idle"
    assert len(speaks(sent)) == before                 # 말없이 취소한다 (2026-09-21 요청)


async def test_button_listening_ends_when_nobody_speaks():
    """버튼을 눌렀는데 아무 말이 없어 마이크가 닫히면 "듣는 중" 표시도 내린다 (2026-09-23: 전에는 계속 남았다)"""
    from test_dialogue_flow import make

    dm, _sent, _ = make()
    await dm.on_button([0])
    assert dm.ribbon_state == "listening" and dm.queue.active() is None
    await dm.mic_closed()
    assert dm.ribbon_state == "idle"


async def test_mic_closed_keeps_listening_when_kid_claimed():
    from test_dialogue_flow import make

    dm, _sent, _ = make()
    await dm.on_button([0])
    await dm.claim(0)                                     # 아이가 말을 시작했다 (거기까지 눌러 마이크가 닫힌 경우)
    await dm.mic_closed()
    assert dm.ribbon_state == "listening" and dm.queue.active() is not None


async def test_heard_nothing_folds_empty_turn():
    from test_dialogue_flow import make, speaks

    dm, sent, _ = make()
    await dm.on_button([0])
    await dm.claim(0)
    before = len(speaks(sent))
    await dm.heard_nothing(0)                             # STT 가 빈 글자를 돌려줬다
    assert dm.queue.active() is None and dm.ribbon_state == "idle"
    assert len(speaks(sent)) == before                    # 말없이


async def test_tick_keeps_listening_without_time_limit():
    """버튼을 눌러 듣기 시작하면 아이가 말할 때까지 시간 제한 없이 기다린다 (2026-09-24 요청)"""
    from test_dialogue_flow import make

    dm, _sent, _ = make()
    await dm.on_button([0])
    await dm.tick()
    assert dm.ribbon_state == "listening"


def test_button_press_with_no_limit_keeps_channels_listening():
    p = procs()
    bc = ButtonCall(p)
    bc.press([0, 1], float("inf"), now=0.0)
    for pr in p.values():
        pr.feed(QUIET, now=1e6)                              # 하루가 지나도
    assert all(p[c].state == "listening" for c in (0, 1))
    assert bc.check(0, now=1e6) is None and bc.armed == [0, 1]   # 아직 기다린다
    p[0].feed(LOUD, now=1e6 + 1)
    assert bc.check(0, now=1e6 + 1) == 0                     # 먼저 말한 아이


def test_button_only_end_does_not_cut_on_silence():
    """오직 버튼으로만 말을 끝낸다 (2026-09-24 요청): 말 중간에 오래 쉬어도 자르지 않고, flush 에 한 덩어리로 나온다"""
    from ribbon.audio.wakeword import make_wakeword
    proc = ChannelProcessor(0, Settings(), make_wakeword(Settings()))
    proc.single_shot = True
    proc.set_end_by_button_only()
    proc.start_listening(0.0, float("inf"))
    events = []
    t = 0.0
    for chunk, n in ((LOUD, 50), (QUIET, 250), (LOUD, 50)):   # 1초 말 - 5초 침묵 - 1초 말
        for _ in range(n):
            t += 0.02
            events += proc.feed(chunk, now=t)
    assert events == [] and proc.state == "listening"          # 침묵 5초에도 자르지 않았다
    out = proc.flush()
    assert out is not None and out.size >= 6.5 * 16000         # 쉰 시간까지 한 덩어리
    assert proc.state == "idle"                                # 버튼 방식: 말 한 번 받았으니 닫는다


def test_set_silence_ms_restores_auto_mode_limits():
    proc = ChannelProcessor(0, Settings(), None)
    proc.set_end_by_button_only()
    proc.set_silence_ms(1300)
    assert proc.segmenter.silence_samples == int(16000 * 1.3)
    assert proc.segmenter.max_samples == 16000 * Settings().max_utterance_s
