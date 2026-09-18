"""대화 관리자: 호출 -> 대기열 -> LLM -> TTS -> 다음 턴.

브로드캐스트 콜백으로 TV/폰 클라이언트에 상태를 알린다. 오디오 입력 쪽(호출어/VAD/STT)은
main.py 가 처리하고 여기에는 on_wake / on_utterance 만 들어온다.
"""
from __future__ import annotations

import asyncio
import itertools
import logging
import re
import time
from typing import Awaitable, Callable, Dict, List, Optional

from .config import Settings
from .kids.profile import call_name
from .kids.registry import KidRegistry
from .persona import ribbon as persona
from .protocol import (KidInfo, RibbonState, RibbonStateMessage, SessionSnapshot, SpeakMessage,
                       TranscriptMessage)
from .providers.llm import LLM
from .providers.tts import TTS
from .queue import Turn, TurnQueue
from .world_store import WorldStore
from .settings_store import ConfigStore

log = logging.getLogger("ribbon.dialogue")
Broadcast = Callable[[dict], Awaitable[None]]
_utt_ids = itertools.count(1)
# 문장 끝(마침표·물음표·느낌표·줄바꿈)에서만 자른다. 한글 어미에서 자르면 문장 중간이 끊긴다.
_SENTENCE_END = re.compile(r"(?<=[.!?。！？…])\s+|\n+")


class DialogueManager:
    def __init__(self, settings: Settings, kids: KidRegistry, llm: LLM, tts: TTS, broadcast: Broadcast,
                 store: Optional[ConfigStore] = None, world: Optional["WorldStore"] = None):
        self.settings = settings
        self.kids = kids
        self.llm = llm
        self.tts = tts
        self.broadcast = broadcast
        self.store = store
        self.world = world
        self.queue = TurnQueue()
        self.ribbon_state: RibbonState = "idle"
        self.target_kid: Optional[str] = None
        self._history: Dict[str, List[Dict[str, str]]] = {}
        self._responding = False
        self._spoken: Dict[str, asyncio.Event] = {}
        self._pending_done: List[tuple] = []   # (utterance_id, Event, 글자수) - 아직 재생 완료를 안 기다린 문장
        self._speak_lock = asyncio.Lock()
        self._last_spoken_at = 0.0
        self.ignore_calls = False                     # 관리자 "호출 무시": 호출어·새 말을 받지 않는다
        self._respond_task: Optional[asyncio.Task] = None
        self._stop_gen = 0                            # "중단"할 때마다 늘린다. 그 전에 줄 서 있던 말은 버린다
        self._waiting: Optional[asyncio.Event] = None  # 지금 재생 완료를 기다리는 문장

    # ---------- 조회 ----------
    def snapshot(self) -> SessionSnapshot:
        config = self.store.config.model_dump() if self.store else {}
        if self.world:
            config["world"] = self.world.tv_view()
        return SessionSnapshot(kids=self.kids.all(), queue=self.queue.snapshot(),
                               ribbon=self.ribbon_state, target_kid=self.target_kid, config=config,
                               ignore_calls=self.ignore_calls)

    async def notify_config_changed(self) -> None:
        """관리자 페이지 저장 후 호출: 모든 화면에 새 설정을 보낸다."""
        await self._broadcast_state()

    @property
    def ribbon_name(self) -> str:
        return self.store.config.ribbon.name if self.store else "리본"

    def _kid_for_channel(self, channel: int) -> KidInfo:
        kid = self.kids.by_channel(channel)
        if kid is None:
            kid = KidInfo(id=f"unknown_{channel}", name="친구", mic_channel=channel)
        return kid

    # ---------- 이벤트 ----------
    async def on_wake(self, channel: int, force: bool = False) -> None:
        """호출. force 는 관리자가 누른 호출 (호출 무시 중에도 받는다)"""
        if self.ignore_calls and not force:
            log.info("호출 무시 중: ch=%s", channel)
            return
        kid = self._kid_for_channel(channel)
        turn, position, created = self.queue.request(kid.id, channel)
        log.info("wake ch=%s kid=%s position=%s created=%s", channel, kid.name, position, created)
        if created:
            await self._broadcast_state()   # 줄을 선 것은 대답("응, 말해봐")이 끝나기 전에 바로 보여 준다
        if position == 0:
            await self._set_ribbon("listening", kid.id)
            if created:
                await self._say(persona.listening_prompt(call_name(kid)), kid.id, final=True)
        elif created:
            active = self.queue.active()
            active_name = call_name(self._kid_for_channel(active.channel)) if active else "친구"
            await self._say(persona.queue_notice(call_name(kid), active_name), kid.id, final=True)
        await self._broadcast_state()

    async def on_utterance(self, channel: int, text: str) -> None:
        text = text.strip()
        if not text:
            return
        kid = self._kid_for_channel(channel)
        log.info("%s> %s", kid.name, text)
        await self.broadcast(TranscriptMessage(kid_id=kid.id, channel=channel, text=text).model_dump())

        if self._is_cancel(text):
            turn = self.queue.cancel(channel)
            if turn:
                log.info("cancel ch=%s", channel)
                await self._say(persona.cancel_notice(call_name(kid)), kid.id, final=True)
            await self._broadcast_state()
            await self._maybe_respond()
            return

        turn = self.queue.add_text(channel, text)
        if turn is None and self.ignore_calls:
            log.info("호출 무시 중이라 새 말은 받지 않음: ch=%s", channel)
            return
        if turn is None:
            # 호출어 없이 후속 발화(follow-up window) -> 새 턴으로 취급
            turn, _, _ = self.queue.request(kid.id, channel)
            turn.append_text(text, time.time())
        await self._broadcast_state()
        await self._maybe_respond()

    async def on_kid_enter(self, kid_id: str) -> None:
        kid = self.kids.set_present(kid_id, True)
        if kid:
            await self.broadcast({"type": "kid.enter", "kid_id": kid_id})
            await self._broadcast_state()  # 아바타가 걸어 들어오는 동안 인사한다
            await self._say(persona.enter_greeting(call_name(kid)), kid.id, final=True)
            if self.queue.active() is None:
                await self._set_ribbon("idle", None)

    async def on_kid_leave(self, kid_id: str) -> None:
        kid = self.kids.set_present(kid_id, False)
        if kid:
            await self.broadcast({"type": "kid.leave", "kid_id": kid_id})
            await self._broadcast_state()

    # ---------- 관리자 조작 (대시보드) ----------
    async def set_ignore_calls(self, on: bool) -> None:
        self.ignore_calls = on
        log.info("호출 무시 %s", "켬" if on else "끔")
        await self._broadcast_state()

    async def stop(self, clear_queue: bool = False) -> None:
        """지금 하던 말·생각을 멈추고 이 차례를 끝낸다. clear_queue 면 기다리는 아이들도 모두 지운다.
        기다리는 아이가 남아 있으면 다음 차례로 넘어간다."""
        task = self._respond_task
        if task and not task.done() and task is not asyncio.current_task():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - 멈춘 작업의 오류는 상관없다
                pass
        self._respond_task = None
        self._responding = False
        self._stop_gen += 1                           # 인사·"말해봐"처럼 차례를 기다리던 말도 하지 않는다
        if self._waiting:
            self._waiting.set()
        for _uid, ev, _n in self._pending_done:
            ev.set()                                   # 재생 완료를 기다리던 곳을 풀어 준다
        self._pending_done.clear()
        self._spoken.clear()
        await self.broadcast({"type": "speak.stop"})   # TV 가 재생 중인 소리와 남은 문장을 버린다
        if clear_queue:
            self.queue.clear()
        else:
            self.queue.complete_active()
        log.info("관리자 중단 (대기열 %s)", "비움" if clear_queue else f"{len(self.queue)}명 남음")
        await self._after_turn()

    def mark_spoken(self, utterance_id: str) -> None:
        """클라이언트가 재생을 끝냈다고 알릴 때 (browser TTS)."""
        ev = self._spoken.get(utterance_id)
        if ev:
            ev.set()

    async def tick(self) -> None:
        """1초마다 호출: 만료/유휴 처리."""
        now = time.time()
        for turn in self.queue.expire(now, self.settings.waiting_timeout_s):
            kid = self._kid_for_channel(turn.channel)
            await self._say(persona.expired_notice(call_name(kid)), kid.id, final=True)
            await self._broadcast_state()
        active = self.queue.active()
        idle_since = max(active.activated_at or 0.0, self._last_spoken_at) if active else 0.0
        if (active and not active.text and not self._responding and not self._speak_lock.locked()
                and idle_since and now - idle_since > self.settings.turn_idle_timeout_s):
            kid = self._kid_for_channel(active.channel)
            self.queue.complete_active(now)
            await self._say(persona.expired_notice(call_name(kid)), kid.id, final=True)
            await self._after_turn()

    # ---------- 내부 ----------
    def _is_cancel(self, text: str) -> bool:
        compact = text.replace(" ", "")
        return any(p.replace(" ", "") in compact for p in self.settings.cancel_phrases)

    async def _maybe_respond(self) -> None:
        active = self.queue.active()
        if active and active.text and not self._responding:
            await self._respond(active)

    async def _respond(self, turn: Turn) -> None:
        self._responding = True
        self._respond_task = asyncio.current_task()   # 관리자 "중단"이 이 작업을 멈춘다
        producer: Optional[asyncio.Task] = None
        kid = self._kid_for_channel(turn.channel)
        text = turn.text
        turn.text = ""  # 응답 중 들어오는 추가 발화는 새 질문으로 쌓인다
        try:
            await self._set_ribbon("thinking", kid.id)
            history = self._history.setdefault(kid.id, [])
            rc = self.store.config.ribbon if self.store else None
            messages = persona.build_messages(
                kid if not kid.id.startswith("unknown_") else None, history, text,
                name=rc.name if rc else "리본", extra=rc.persona_extra if rc else "",
                max_sentences=rc.max_sentences if rc else 3)

            max_sentences = rc.max_sentences if rc else 3
            sentences: List[str] = []
            synth: List[asyncio.Task] = []   # 문장이 완성되는 즉시 합성을 시작한다 (pipelining)
            first_ready = asyncio.Event()

            async def produce() -> None:
                pending = ""
                truncated = False
                async for delta in self.llm.stream(messages):
                    pending += delta
                    parts = _SENTENCE_END.split(pending)
                    if len(parts) > 1:
                        for s in parts[:-1]:
                            if s.strip():
                                sentences.append(s.strip())
                                synth.append(asyncio.create_task(self.tts.synthesize(s.strip())))
                                first_ready.set()
                        pending = parts[-1]
                    if len(sentences) >= max_sentences:
                        truncated = True
                        break
                if not truncated and pending.strip():
                    sentences.append(pending.strip())
                    synth.append(asyncio.create_task(self.tts.synthesize(pending.strip())))
                if truncated:
                    log.info("답이 %d문장을 넘어 잘랐음", max_sentences)
                if not sentences:
                    log.warning("LLM 이 빈 답을 돌려줌 (모델 오류 또는 빈 응답). 입력: %s", text)
                    sentences.append("음, 다시 한 번 말해줄래?")
                    synth.append(asyncio.create_task(self.tts.synthesize(sentences[0])))
                first_ready.set()

            producer = asyncio.create_task(produce())

            # 1) 인식 직후 즉시 반응 (LLM 을 기다리지 않는다)
            if rc is None or rc.ack_enabled:
                await self._say(persona.acknowledge(text, call_name(kid)), kid.id, final=False, wait=True)
                await self._set_ribbon("thinking", kid.id)
            # 2) 첫 문장이 늦으면 추임새로 침묵을 메운다
            if rc is None or rc.filler_enabled:
                delay = rc.filler_delay_s if rc else 1.5
                n = 0
                while not first_ready.is_set():
                    try:
                        await asyncio.wait_for(first_ready.wait(), timeout=delay)
                    except asyncio.TimeoutError:
                        if first_ready.is_set():
                            break
                        await self._say(persona.filler(n), kid.id, final=False, wait=True)
                        await self._set_ribbon("thinking", kid.id)
                        n += 1
                        delay = rc.filler_interval_s if rc else 4.0
                        if n >= 4:
                            break
            # 3) 준비된 문장부터 순서대로 재생 (앞 문장은 기다리지 않고 이어 보낸다)
            i = 0
            while True:
                while i >= len(sentences) and not producer.done():
                    await asyncio.sleep(0.05)
                if i >= len(sentences):
                    break
                audio = await synth[i]
                is_last = producer.done() and i == len(sentences) - 1
                await self._say(sentences[i], kid.id, final=is_last, audio=audio, wait=False)
                i += 1
            await producer
            await self._wait_spoken()

            history.append({"role": "user", "content": text})
            history.append({"role": "assistant", "content": " ".join(sentences)})
            del history[:-16]
        except Exception:
            log.exception("LLM 응답 실패")
            await self._say("미안, 잠깐 생각이 안 났어. 다시 말해줄래?", kid.id, final=True)
        finally:
            self._responding = False
            if producer and not producer.done():
                producer.cancel()                     # 중단되면 LLM 스트림도 닫는다
        self.queue.complete_active()
        await self._after_turn()

    async def _after_turn(self) -> None:
        nxt = self.queue.active()
        if nxt is None:
            await self._set_ribbon("idle", None)
            await self._broadcast_state()
            return
        kid = self._kid_for_channel(nxt.channel)
        await self._set_ribbon("listening", kid.id)
        await self._broadcast_state()
        if nxt.text:
            nxt.text = persona.recall_prefix(call_name(kid)) + nxt.text
            await self._respond(nxt)
        else:
            await self._say(persona.listening_prompt(call_name(kid)), kid.id, final=True)

    async def _say(self, text: str, kid_id: Optional[str], final: bool,
                   audio: Optional[bytes] = None, wait: bool = True) -> None:
        """한 문장을 보낸다. audio 가 없으면 여기서 합성한다. wait=False 면 재생 완료를 기다리지 않고
        다음 문장을 바로 보낸다 (클라이언트가 순서대로 이어 재생). 마지막 문장은 wait=True 로 기다린다."""
        gen = self._stop_gen
        async with self._speak_lock:
            if gen != self._stop_gen:
                return                                # 기다리는 사이 관리자가 중단했다
            utt_id = f"u{next(_utt_ids)}"
            log.info("리본> %s", text)
            await self._set_ribbon("speaking", kid_id)
            if audio is None:
                audio = await self.tts.synthesize(text)
            audio_b64 = None
            if audio:
                import base64
                audio_b64 = base64.b64encode(audio).decode("ascii")
            ev = asyncio.Event()
            self._spoken[utt_id] = ev
            self._pending_done.append((utt_id, ev, len(text)))
            await self.broadcast(SpeakMessage(utterance_id=utt_id, text=text, kid_id=kid_id,
                                              audio_b64=audio_b64, final=final).model_dump())
            if wait:
                await self._wait_spoken()

    async def _wait_spoken(self) -> None:
        """지금까지 보낸 문장들의 재생 완료를 순서대로 기다린다 (문장당 최대 글자수 비례 시간)."""
        while self._pending_done:
            uid, pending_ev, n = self._pending_done.pop(0)
            self._waiting = pending_ev
            try:
                await asyncio.wait_for(pending_ev.wait(), timeout=2.0 + 0.25 * n)
            except asyncio.TimeoutError:
                pass
            finally:
                self._waiting = None
                self._spoken.pop(uid, None)
        self._last_spoken_at = time.time()

    async def _set_ribbon(self, state: RibbonState, target_kid: Optional[str]) -> None:
        self.ribbon_state = state
        self.target_kid = target_kid
        await self.broadcast(RibbonStateMessage(state=state, target_kid=target_kid).model_dump())

    async def _broadcast_state(self) -> None:
        await self.broadcast(self.snapshot().model_dump())
