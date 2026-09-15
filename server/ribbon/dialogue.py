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
from .kids.registry import KidRegistry
from .persona import ribbon as persona
from .protocol import (KidInfo, RibbonState, RibbonStateMessage, SessionSnapshot, SpeakMessage,
                       TranscriptMessage)
from .providers.llm import LLM
from .providers.tts import TTS
from .queue import Turn, TurnQueue
from .room_store import RoomStore
from .settings_store import ConfigStore

log = logging.getLogger("ribbon.dialogue")
Broadcast = Callable[[dict], Awaitable[None]]
_utt_ids = itertools.count(1)
# 문장 끝(마침표·물음표·느낌표·줄바꿈)에서만 자른다. 한글 어미에서 자르면 문장 중간이 끊긴다.
_SENTENCE_END = re.compile(r"(?<=[.!?。！？…])\s+|\n+")


class DialogueManager:
    def __init__(self, settings: Settings, kids: KidRegistry, llm: LLM, tts: TTS, broadcast: Broadcast,
                 store: Optional[ConfigStore] = None, room: Optional["RoomStore"] = None):
        self.settings = settings
        self.kids = kids
        self.llm = llm
        self.tts = tts
        self.broadcast = broadcast
        self.store = store
        self.room = room
        self.queue = TurnQueue()
        self.ribbon_state: RibbonState = "idle"
        self.target_kid: Optional[str] = None
        self._history: Dict[str, List[Dict[str, str]]] = {}
        self._responding = False
        self._spoken: Dict[str, asyncio.Event] = {}
        self._pending_done: List[tuple] = []   # (utterance_id, Event, 글자수) - 아직 재생 완료를 안 기다린 문장
        self._speak_lock = asyncio.Lock()
        self._last_spoken_at = 0.0

    # ---------- 조회 ----------
    def snapshot(self) -> SessionSnapshot:
        config = self.store.config.model_dump() if self.store else {}
        if self.room:
            config["room"] = self.room.spec.model_dump()
        return SessionSnapshot(kids=self.kids.all(), queue=self.queue.snapshot(),
                               ribbon=self.ribbon_state, target_kid=self.target_kid, config=config)

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
    async def on_wake(self, channel: int) -> None:
        kid = self._kid_for_channel(channel)
        turn, position, created = self.queue.request(kid.id, channel)
        log.info("wake ch=%s kid=%s position=%s created=%s", channel, kid.name, position, created)
        if position == 0:
            await self._set_ribbon("listening", kid.id)
            if created:
                await self._say(persona.listening_prompt(kid.name), kid.id, final=True)
        elif created:
            active = self.queue.active()
            active_name = self._kid_for_channel(active.channel).name if active else "친구"
            await self._say(persona.queue_notice(kid.name, active_name), kid.id, final=True)
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
                await self._say(persona.cancel_notice(kid.name), kid.id, final=True)
            await self._broadcast_state()
            await self._maybe_respond()
            return

        turn = self.queue.add_text(channel, text)
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
            await self._say(persona.enter_greeting(kid.name), kid.id, final=True)
            if self.queue.active() is None:
                await self._set_ribbon("idle", None)

    async def on_kid_leave(self, kid_id: str) -> None:
        kid = self.kids.set_present(kid_id, False)
        if kid:
            await self.broadcast({"type": "kid.leave", "kid_id": kid_id})
            await self._broadcast_state()

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
            await self._say(persona.expired_notice(kid.name), kid.id, final=True)
            await self._broadcast_state()
        active = self.queue.active()
        idle_since = max(active.activated_at or 0.0, self._last_spoken_at) if active else 0.0
        if (active and not active.text and not self._responding and not self._speak_lock.locked()
                and idle_since and now - idle_since > self.settings.turn_idle_timeout_s):
            kid = self._kid_for_channel(active.channel)
            self.queue.complete_active(now)
            await self._say(persona.expired_notice(kid.name), kid.id, final=True)
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
            full = ""
            pending = ""
            sentences: List[str] = []
            # 문장이 완성되는 즉시 합성을 시작해 두고(pipelining), 재생은 순서대로 한다
            synth: List[asyncio.Task] = []
            truncated = False
            async for delta in self.llm.stream(messages):
                full += delta
                pending += delta
                parts = _SENTENCE_END.split(pending)
                if len(parts) > 1:
                    for s in parts[:-1]:
                        if s.strip():
                            sentences.append(s.strip())
                            synth.append(asyncio.create_task(self.tts.synthesize(s.strip())))
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
            for i, (s, task) in enumerate(zip(sentences, synth)):
                audio = await task
                # 마지막 문장만 재생 완료를 기다린다. 앞 문장들은 클라이언트가 순서대로 이어 재생한다
                await self._say(s, kid.id, final=(i == len(sentences) - 1), audio=audio, wait=(i == len(sentences) - 1))

            history.append({"role": "user", "content": text})
            history.append({"role": "assistant", "content": " ".join(sentences)})
            del history[:-16]
        except Exception:
            log.exception("LLM 응답 실패")
            await self._say("미안, 잠깐 생각이 안 났어. 다시 말해줄래?", kid.id, final=True)
        finally:
            self._responding = False
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
            nxt.text = persona.recall_prefix(kid.name) + nxt.text
            await self._respond(nxt)
        else:
            await self._say(persona.listening_prompt(kid.name), kid.id, final=True)

    async def _say(self, text: str, kid_id: Optional[str], final: bool,
                   audio: Optional[bytes] = None, wait: bool = True) -> None:
        """한 문장을 보낸다. audio 가 없으면 여기서 합성한다. wait=False 면 재생 완료를 기다리지 않고
        다음 문장을 바로 보낸다 (클라이언트가 순서대로 이어 재생). 마지막 문장은 wait=True 로 기다린다."""
        async with self._speak_lock:
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
            if not wait:
                return
            # 지금까지 보낸 문장들의 재생 완료를 순서대로 기다린다 (문장당 최대 글자수 비례 시간)
            while self._pending_done:
                uid, pending_ev, n = self._pending_done.pop(0)
                try:
                    await asyncio.wait_for(pending_ev.wait(), timeout=2.0 + 0.25 * n)
                except asyncio.TimeoutError:
                    pass
                finally:
                    self._spoken.pop(uid, None)
            self._last_spoken_at = time.time()

    async def _set_ribbon(self, state: RibbonState, target_kid: Optional[str]) -> None:
        self.ribbon_state = state
        self.target_kid = target_kid
        await self.broadcast(RibbonStateMessage(state=state, target_kid=target_kid).model_dump())

    async def _broadcast_state(self) -> None:
        await self.broadcast(self.snapshot().model_dump())
