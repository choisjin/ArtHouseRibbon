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
from typing import TYPE_CHECKING, Awaitable, Callable, Dict, List, Optional

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
from . import memory as mem
from .memory import MemoryStore
from .knowledge.pokedex import Pokedex, knowledge_block
from .games.pokemon_quiz import PokemonQuiz, detect_start, explicit_pokemon
from .settings_store import ConfigStore

if TYPE_CHECKING:
    from .music_intent import MusicControl

log = logging.getLogger("ribbon.dialogue")
Broadcast = Callable[[dict], Awaitable[None]]
_utt_ids = itertools.count(1)
# 문장 끝(마침표·물음표·느낌표·줄바꿈)에서만 자른다. 한글 어미에서 자르면 문장 중간이 끊긴다.
_SENTENCE_END = re.compile(r"(?<=[.!?。！？…])\s+|\n+")
QUIZ_NEXT_DELAY_S = 2.0        # 포켓몬 맞추기: 정답을 보여 주고 다음 문제로 넘어가기 전 쉬는 시간


class DialogueManager:
    def __init__(self, settings: Settings, kids: KidRegistry, llm: LLM, tts: TTS, broadcast: Broadcast,
                 store: Optional[ConfigStore] = None, world: Optional["WorldStore"] = None,
                 memory: Optional[MemoryStore] = None, pokedex: Optional[Pokedex] = None,
                 music: Optional["MusicControl"] = None):
        self.settings = settings
        self.kids = kids
        self.llm = llm
        self.tts = tts
        self.broadcast = broadcast
        self.store = store
        self.world = world
        self.memory = memory
        self.pokedex = pokedex
        self.quiz: Optional[PokemonQuiz] = PokemonQuiz(pokedex) if pokedex is not None else None
        self.music = music                             # Spotify 부탁 ("피카츄 노래 틀어줘", music_intent.py)
        self._recent_dex: Dict[str, tuple] = {}         # 아이 -> (최근에 이야기한 포켓몬들, 남은 턴) "걔는 뭐 먹어?" 용
        self._learn_lock = asyncio.Lock()              # 약속 뽑기는 한 번에 하나씩 (대화 모델 부담)
        self._bg: set = set()                          # 뒤에서 도는 약속 뽑기 작업
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
        self._more: Optional[asyncio.Event] = None     # 답을 생각하는 중에 아이가 이어 말했다
        self._hold_until = 0.0                         # "띵" 소리가 마이크로 다시 들어가지 않게 잠깐 막는다
        self._said: List[tuple] = []                   # (띄어쓰기 뺀 문장, 시각) 리본이가 방금 한 말 (자기 목소리 듣기 막기)
        self._barged = False                           # 아이가 끼어들었다: 리본이가 다시 말할 때까지 에코 막기를 쉰다
        self._tts_cache: Dict[tuple, Optional[bytes]] = {}   # (말, 목소리 설정) -> 합성한 소리

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
        self._spawn_bg(self.prewarm())                 # 목소리를 바꿨으면 자주 쓰는 말을 새 목소리로 다시

    # ---------- 자주 쓰는 말(추임새)은 미리 합성해 둔다 ----------
    def _voice_key(self) -> tuple:
        rc = self.store.config.ribbon if self.store else None
        return (rc.voice, rc.speed, rc.steps, rc.pitch) if rc else ()

    def _cacheable(self, text: str) -> bool:
        return text in persona._FILLERS

    async def _synth(self, text: str) -> Optional[bytes]:
        if not self._cacheable(text):
            return await self.tts.synthesize(text)
        key = (text, self._voice_key())
        if key not in self._tts_cache:
            self._tts_cache[key] = await self.tts.synthesize(text)
        return self._tts_cache[key]

    async def prewarm(self) -> None:
        """서버가 켜질 때·목소리를 바꿨을 때: 추임새를 미리 만들어 둔다"""
        vk = self._voice_key()
        self._tts_cache = {k: v for k, v in self._tts_cache.items() if k[1] == vk}
        for text in persona._FILLERS:
            try:
                await self._synth(text)
            except Exception:  # noqa: BLE001 - 미리 만들기 실패는 말할 때 다시 해 본다
                log.exception("미리 합성 실패: %s", text)
                return

    @property
    def ribbon_name(self) -> str:
        return self.store.config.ribbon.name if self.store else "리본"

    def _kid_for_channel(self, channel: int) -> KidInfo:
        kid = self.kids.by_channel(channel)
        if kid is None:
            kid = KidInfo(id=f"unknown_{channel}", name="친구", mic_channel=channel)
        return kid

    # ---------- 이벤트 ----------
    async def on_wake(self, channel: int, force: bool = False, by_voice: bool = False) -> None:
        """호출. force 는 관리자가 누른 호출 (호출 무시 중에도 받는다).
        by_voice 는 마이크 말소리(호출어·energy)로 깨어난 것: 아이가 이미 말하는 중이라 "띵"·"말해봐"·줄 안내를
        하지 않는다. 소리를 내면 에코 막기로 마이크를 잠깐 막아서, 깨운 그 말이 버려진다 ("리본아" 를 먼저 해야 했음)"""
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
            if created and not by_voice:
                await self._listen_cue(kid)
        elif created and not by_voice:            # 말로 깨운 아이는 말을 기억해 두었다가 차례가 오면 답한다
            active = self.queue.active()
            active_name = call_name(self._kid_for_channel(active.channel)) if active else "친구"
            await self._say(persona.queue_notice(call_name(kid), active_name), kid.id, final=True)
        await self._broadcast_state()

    def _button_only(self) -> bool:
        return bool(self.store and self.store.config.ribbon.input_mode == "button")

    def note_barge_in(self) -> None:
        """끼어들기를 알아챈 바로 그 순간 (main 이 오디오를 처리하며 부른다): 다음 소리 조각부터 마이크를 막지 않는다"""
        self._barged = True

    async def barge_in(self, channel: int) -> None:
        """아이가 리본이 말하는 중에 말을 시작했다 (audio/bargein.py). 리본이는 하던 말·생각을 멈추고 그 말을 기다린다"""
        kid = self._kid_for_channel(channel)
        log.info("끼어들기: %s (ch=%s) - 리본이 말 멈춤", kid.name, channel)
        self._barged = True
        if self._responding or self._pending_done or self._speak_lock.locked() or self._waiting:
            await self.stop(advance=False, reason=f"{kid.name} 끼어들기")
        else:
            await self.broadcast({"type": "speak.stop"})
        self._barged = True                            # stop 이 에코 막기를 되살리지 않게
        if self.queue.active() is None or (self.quiz and self.quiz.active):
            await self._set_ribbon("listening", kid.id)

    def busy(self) -> bool:
        """말하거나 생각하거나, 차례를 기다리는 아이가 있는가"""
        return self._responding or self._speak_lock.locked() or bool(self._pending_done) or len(self.queue) > 0

    async def reset_for_button(self) -> None:
        """호출 버튼: 하던 대화(말·생각·대기 줄)를 모두 멈추고 새로 들을 준비. 누가 눌렀는지 몰라 줄도 비운다"""
        if self.busy():
            await self.stop(clear_queue=True, advance=False, reason="호출 버튼으로 대화 멈춤")

    async def on_button(self, channels: List[int]) -> None:
        """호출 버튼(DJI 송신기)이 눌렸다. 말은 하지 않는다 (2026-09-20 "지금 말해줘" 삭제). main 이 채널들을 바로
        듣기 시작하고, 듣는 동안 TV 오른쪽 위에 마이크 표시가 뜬다 (main._update_mic). 먼저 말하는 아이를 기다린다 (claim)"""
        log.info("호출 버튼: 채널 %s", [c + 1 for c in channels])
        self._barged = False
        await self.broadcast({"type": "button", "channels": channels})
        await self._set_ribbon("listening", None)

    async def claim(self, channel: int) -> None:
        """버튼 뒤 가장 먼저 말을 시작한 채널: 그 아이 차례를 만든다 (말이 끝나면 바로 대답한다)"""
        kid = self._kid_for_channel(channel)
        turn, position, created = self.queue.request(kid.id, channel)
        log.info("호출 버튼: %s 이(가) 먼저 말함 (ch=%s, 순서 %s)", kid.name, channel, position)
        if position == 0 and not self._responding:
            await self._set_ribbon("listening", kid.id)
        if created:
            await self._broadcast_state()

    async def on_utterance(self, channel: int, text: str) -> None:
        text = text.strip()
        if not text:
            return
        kid = self._kid_for_channel(channel)
        # 게임 고르기 화면에서는 아이가 리본이가 읽어 준 게임 이름을 따라 말한다 ("그림 보고 맞추기"). 짧은 말은 에코로 버리지 않는다
        choosing = bool(self.quiz and self.quiz.active and self.quiz.phase in ("choosing", "confirm")
                        and len(self._compact(text)) <= 12)
        if not choosing and self._is_own_echo(text):
            log.info("리본이가 방금 한 말이 마이크로 들어온 것 같아 버림: ch=%s %s", channel, text)
            return
        log.info("%s> %s", kid.name, text)
        await self.broadcast(TranscriptMessage(kid_id=kid.id, channel=channel, text=text).model_dump())

        # 포켓몬 맞추기 게임: 게임 중에는 누가 말하든 답으로 본다 (대화 모델을 거치지 않는다)
        if self.quiz and self.quiz.active:
            if await self._quiz_turn(kid, channel, text):
                return
        elif (mode := detect_start(text)) is not None:
            # "놀자" 같은 말이면 먼저 "포켓몬 맞추기 할까?" 묻고, "포켓몬 맞추기 하자" 처럼 콕 집으면 바로 고르기 화면
            # 도감이 없으면 없다고 알려 준다 (대화 모델로 넘기지 않는다)
            await self.start_quiz(mode, kid, channel, ask_first=not explicit_pokemon(text))
            return

        # 음악 부탁: 게임 중이 아니면 먼저 본다 (대화 모델을 거치지 않는다)
        if self.music is not None and not (self.quiz and self.quiz.active):
            lines = await self.music.handle(text, self.ribbon_name)
            if self.music.take_view_change():        # TV 에 띄운 번호 목록 ("플레이리스트 보여줘")
                await self.broadcast({"type": "music.list", "view": self.music.list_view()})
            if lines is not None:
                await self._music_reply(lines, kid, channel)
                return

        if self._is_cancel(text):
            active = self.queue.active()
            if active is not None and active.channel == channel:
                # 지금 이 아이 차례: 생각·말하던 것도 멈추고 차례를 끝낸다
                await self.stop(advance=False, reason=f"{kid.name} 음성 취소")
                await self._say(persona.cancel_notice(call_name(kid)), kid.id, final=True)
                await self._after_turn()
                return
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
        elif self._responding and turn is self.queue.active() and self._more:
            self._more.set()   # 답을 생각하는 중이면 앞말과 합쳐 다시 생각한다 (말하는 중이면 끝난 뒤 이어서)
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

    async def stop(self, clear_queue: bool = False, advance: bool = True, reason: str = "관리자 중단") -> None:
        """지금 하던 말·생각을 멈추고 이 차례를 끝낸다. clear_queue 면 기다리는 아이들도 모두 지운다.
        advance 면 기다리는 아이가 남아 있을 때 다음 차례로 넘어간다 (아니면 부른 쪽이 이어서 처리)."""
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
        log.info("%s (대기열 %s)", reason, "비움" if clear_queue else f"{len(self.queue)}명 남음")
        if advance:
            await self._after_turn()
        else:
            await self._broadcast_state()

    def speaking(self, now: Optional[float] = None) -> bool:
        """리본이 목소리가 스피커에서 나오고 있을 수 있는가 (말하는 중 + 끝난 뒤 echo_tail_ms)"""
        now = time.time() if now is None else now
        if self._barged:
            return False                               # 끼어든 아이 말을 받는 중 (마이크를 막지 않는다)
        if now < self._hold_until:
            return True
        if self._speak_lock.locked() or self._pending_done or self._waiting is not None:
            return True
        return now - self._last_spoken_at < self.settings.echo_tail_ms / 1000

    def mark_spoken(self, utterance_id: str) -> None:
        """클라이언트가 재생을 끝냈다고 알릴 때 (browser TTS)."""
        ev = self._spoken.get(utterance_id)
        if ev:
            ev.set()

    # ---------- 포켓몬 맞추기 게임 (games/pokemon_quiz.py) ----------
    async def start_quiz(self, mode: str, kid: Optional[KidInfo] = None, channel: Optional[int] = None,
                         confirm: bool = True, ask_first: bool = False) -> None:
        """게임 시작. 아이가 하자고 하면(confirm) TV 에 고르기 화면 -> 고른 걸 반짝이며 한 번 더 묻고 시작.
        선생님이 대시보드에서 누르면 바로 시작 (mode "" 면 고르기 화면)"""
        if not self.quiz or not len(self.pokedex or []):
            log.warning("포켓몬 맞추기를 하자는데 도감이 없습니다 (python tools/fetch_pokedex.py)")
            if channel is not None:
                self.queue.cancel(channel)
            await self._say("포켓몬 도감이 아직 없어서 맞추기를 못 해. 선생님께 도감을 받아 달라고 해 줘.",
                            kid.id if kid else None, final=True)
            return
        rc = self.store.config.ribbon if self.store else None
        self.quiz.max_id = rc.game_max_id if rc else 1025
        log.info("포켓몬 맞추기 시작: %s", mode or "고르는 중")
        if ask_first:
            reply = self.quiz.offer(mode)
        else:
            reply = self.quiz.open_menu(mode) if confirm else self.quiz.start(mode)
        await self._quiz_reply(reply, kid, channel)

    async def stop_quiz(self) -> None:
        if self.quiz and self.quiz.active:
            await self._quiz_reply(self.quiz.stop(), None, None)

    async def _quiz_turn(self, kid: KidInfo, channel: int, text: str) -> bool:
        """게임 중 아이 말. 게임과 상관없는 말이면 False (게임을 끝내고 보통 대화로)"""
        reply = self.quiz.handle(text)
        if reply.passthrough:
            await self.broadcast({"type": "game", "view": None})
            return False
        await self._quiz_reply(reply, kid, channel)
        return True

    async def _quiz_reply(self, reply, kid: Optional[KidInfo], channel: Optional[int]) -> None:
        if channel is not None:
            self.queue.cancel(channel)                 # 게임은 줄(차례) 없이 한다
        kid_id = kid.id if kid else None
        gen = self._stop_gen
        while True:
            await self.broadcast({"type": "game", "view": self.quiz.view()})
            for i, line in enumerate(reply.lines):
                await self._say(line, kid_id, final=i == len(reply.lines) - 1)
            if reply.new_round and self.quiz.mode == "describe" and not self.quiz.answer.get("look"):
                self._spawn_bg(self._quiz_appearance(self.quiz.answer))   # 생김새 설명이 아직 없는 포켓몬: 그림을 보고 만든다
            if not (reply.auto_next and self.quiz.active):
                break
            await asyncio.sleep(QUIZ_NEXT_DELAY_S)     # 정답 그림을 잠깐 보여 주고 다음 문제로
            if not self.quiz.active or gen != self._stop_gen:
                break                                  # 그 사이 그만뒀다 (그만할래 · 관리자 중단)
            reply = self.quiz.next_round()
        if self.quiz.active and not self._button_only():
            await self._set_ribbon("listening", None)  # 답을 기다린다 (버튼 방식이면 버튼을 눌러야 들으니 표시하지 않는다)
        elif self.quiz.active:
            await self._set_ribbon("idle", None)
        await self._broadcast_state()

    async def _music_reply(self, lines: List[str], kid: KidInfo, channel: int) -> None:
        """음악 부탁에 짧게 답하고 이 아이 차례를 끝낸다"""
        self.queue.cancel(channel)
        for i, line in enumerate(lines):
            await self._say(line, kid.id, final=i == len(lines) - 1)
        if self._responding:
            await self._broadcast_state()              # 다른 아이에게 답하는 중이었다: 그 흐름은 그대로
        else:
            await self._after_turn()

    async def _pokemon_png(self, pid: int) -> Optional[bytes]:
        """공식 그림 (서버가 받아 둔 data/pokemon_img/ 에 있으면 그것)"""
        path = self.settings.pokedex_path().parent / "pokemon_img" / f"{pid}.png"
        if path.exists():
            return path.read_bytes()
        import httpx
        url = f"https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/{pid}.png"
        try:
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as c:
                r = await c.get(url)
                r.raise_for_status()
        except httpx.HTTPError:
            return None
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(r.content)
        return r.content

    async def _quiz_appearance(self, entry: Dict) -> None:
        """설명 듣고 맞추기: 생김새 설명이 없는 포켓몬이면 공식 그림을 대화 모델에게 보여 주고 받아서 힌트로 쓰고 저장한다.
        그림을 못 보는 모델이면 이름만으로 (덜 정확) 받는다"""
        import base64
        from .knowledge.pokedex import LOOK_PROMPT, clean_look
        png = await self._pokemon_png(entry["id"])
        if png:
            msgs = [{"role": "user", "content": [
                {"type": "text", "text": LOOK_PROMPT.format(name=entry["name"]) + " /no_think"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}}]}]
            try:
                lines = clean_look("".join([d async for d in self.llm.stream(msgs)]), entry["name"])
            except Exception:  # noqa: BLE001 - 그림을 못 보는 모델 등
                log.warning("그림을 보고 생김새 설명 만들기 실패 - 이름만으로 해 본다")
                lines = []
            if len(lines) >= 2:
                if self.pokedex:
                    self.pokedex.save_look(entry["id"], lines)
                if self.quiz.answer is entry:
                    self.quiz.appearance = lines
                log.info("생김새 설명 (그림을 보고): %s", lines)
                return
        msgs = [{"role": "system", "content": "너는 포켓몬을 잘 아는 도우미야. 모르면 모른다고만 한다."},
                {"role": "user", "content": (
                    f"포켓몬 '{entry['name']}'({entry.get('genus', '')}, {'/'.join(entry.get('types') or [])} 타입)의 "
                    "생김새를 어린이가 알아듣게 짧은 두 문장으로 설명해 줘. 색깔과 모양 위주로. "
                    "이름은 절대 말하지 말고 '이 포켓몬' 이라고 한다. 확실히 모르면 '모름' 이라고만 답해. /no_think")}]
        try:
            raw = "".join([d async for d in self.llm.stream(msgs)])
        except Exception:  # noqa: BLE001
            log.exception("생김새 힌트 만들기 실패")
            return
        raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.S).strip()
        if not raw or "모름" in raw or entry["name"] in raw or self.quiz.answer is not entry:
            return
        self.quiz.appearance = [s.strip() for s in _SENTENCE_END.split(raw) if s.strip()][:2]
        log.info("생김새 힌트: %s", self.quiz.appearance)

    def _spawn_bg(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._bg.add(task)
        task.add_done_callback(self._bg.discard)

    async def tick(self) -> None:
        """1초마다 호출: 만료/유휴 처리."""
        now = time.time()
        if self.quiz and self.quiz.active and now - self.quiz.last_at > 180:
            log.info("포켓몬 맞추기: 3분 동안 답이 없어 끝냄")
            self.quiz.active = False
            await self.broadcast({"type": "game", "view": None})
            await self._set_ribbon("idle", None)
        if self.music is not None and self.music.tick():     # 오래 둔 번호 목록 내리기
            await self.broadcast({"type": "music.list", "view": self.music.list_view()})
        for turn in self.queue.expire(now, self.settings.waiting_timeout_s):
            kid = self._kid_for_channel(turn.channel)
            await self._say(persona.expired_notice(call_name(kid)), kid.id, final=True)
            await self._broadcast_state()
        active = self.queue.active()
        idle_since = max(active.activated_at or 0.0, self._last_spoken_at) if active else 0.0
        if (active and not active.text and not self._responding and not self._speak_lock.locked()
                and not (self.quiz and self.quiz.active)
                and idle_since and now - idle_since > self.settings.turn_idle_timeout_s):
            kid = self._kid_for_channel(active.channel)
            self.queue.complete_active(now)
            await self._say(persona.expired_notice(call_name(kid)), kid.id, final=True)
            await self._after_turn()

    # ---------- 내부 ----------
    # ---------- 음성 인식 힌트 ----------
    def stt_prompt(self) -> str:
        """Whisper initial_prompt: 여기 나온 낱말(아이·캐릭터 이름, 게임 말)을 훨씬 잘 알아듣는다.
        게임 정답은 넣지 않는다 (넣으면 그 이름을 지어내 정답 처리될 수 있다)"""
        names = []
        for k in self.kids.all():
            names += [k.name] + ([k.nickname] if k.nickname and k.nickname != k.name else [])
        chars = [self.ribbon_name] + ([p.name for p in self.store.config.characters.values()] if self.store else [])
        words = list(dict.fromkeys(n for n in names + chars if n))
        text = f"{', '.join(words)}. 아이가 {self.ribbon_name}에게 말한다. 그림, 포켓몬, 공룡, 선생님."
        if self.quiz and self.quiz.active:
            text += " 포켓몬 맞추기, 힌트, 정답, 모르겠어, 다음 문제, 1번, 2번, 3번, 설명 듣고, 그림 보고, 조금 보고, 응, 아니."
        return text[:400]

    # ---------- 도감 (knowledge/) ----------
    def _knowledge(self, kid: KidInfo, text: str) -> str:
        """아이 말에 포켓몬이 나오면 도감 정보를 참고 자료로. 다음 두 번까지는 "걔는 뭐 먹어?" 도 알아듣게 이어 준다"""
        rc = self.store.config.ribbon if self.store else None
        if self.pokedex is None or not len(self.pokedex) or (rc is not None and not rc.pokedex_enabled):
            return ""
        found = self.pokedex.find(text)
        if found:
            log.info("포켓몬 도감: %s", ", ".join(e["name"] for e in found))
            self._recent_dex[kid.id] = (found, 2)
        else:
            recent = self._recent_dex.get(kid.id)
            if not recent or recent[1] <= 0:
                return ""
            found = recent[0]
            self._recent_dex[kid.id] = (found, recent[1] - 1)
        return knowledge_block(found)

    # ---------- 약속 기억하기 (memory.py) ----------
    def _memory_on(self) -> bool:
        rc = self.store.config.ribbon if self.store else None
        return self.memory is not None and (rc is None or rc.memory_enabled)

    def _promises(self, kid: KidInfo) -> str:
        if not self._memory_on():
            return ""
        kid_id = None if kid.id.startswith("unknown_") else kid.id
        return mem.prompt_block(self.memory.for_kid(kid_id), call_name(kid))

    def _maybe_learn(self, kid: KidInfo, kid_said: str, reply: str, before: List[Dict[str, str]]) -> None:
        """아이 말에 지적·금지 표현이 있으면 대답이 끝난 뒤 뒤에서 약속을 뽑는다 (대답은 기다리지 않는다)"""
        if not self._memory_on() or kid.id.startswith("unknown_") or not mem.looks_like_correction(kid_said):
            return
        # 아이가 고친 것은 보통 리본이가 그 전에 한 말이다
        prev = next((m["content"] for m in reversed(before) if m["role"] == "assistant"), "")
        task = asyncio.create_task(self._learn(kid, kid_said, prev or reply))
        self._bg.add(task)
        task.add_done_callback(self._bg.discard)

    async def _learn(self, kid: KidInfo, kid_said: str, ribbon_said: str) -> None:
        assert self.memory is not None
        async with self._learn_lock:
            mine = self.memory.list(kid.id)
            msgs = mem.extract_messages(self.ribbon_name, call_name(kid), mine, ribbon_said, kid_said)
            try:
                raw = "".join([d async for d in self.llm.stream(msgs)])
            except Exception:  # noqa: BLE001 - 약속 뽑기가 실패해도 대화는 계속된다
                log.exception("약속 뽑기 실패")
                return
            changes = mem.parse_changes(raw)
            removed = [r.text for r in mine if r.id in changes["remove"] and self.memory.remove(r.id)]
            if self.store:
                self.memory.max_per_kid = self.store.config.ribbon.memory_max_per_kid
            added = [r.text for t in changes["add"] if (r := self.memory.add(t, kid.id, source=kid_said))]
            if added or removed:
                log.info("약속 %s: +%s -%s", kid.name, added, removed)
                await self.broadcast({"type": "memory.changed", "kid_id": kid.id, "added": added, "removed": removed})

    @staticmethod
    def _compact(text: str) -> str:
        return "".join(ch for ch in text if ch.isalnum())

    def _is_own_echo(self, text: str) -> bool:
        """들은 말이 리본이가 방금 한 말과 겹치면 스피커 소리가 다시 들어온 것 (에코 막기 시간이 지난 뒤의 울림 등).
        에코는 리본이 문장을 거의 다 옮기고, 아이는 일부만 따라 한다 ("포켓몬 맞추기 하자" <- 리본: "좋아, 포켓몬 맞추기
        하자! 1번 …"). 그래서 리본이 문장의 60% 이상을 옮겼을 때만 에코로 본다. 버튼 방식은 리본이가 말할 때 마이크가
        닫혀 있어서 말이 끝난 직후 3초만 본다"""
        now = time.time()
        window_s = 3.0 if self._button_only() else 15.0
        self._said = [(s, t) for s, t in self._said if now - t < 15.0]
        heard = self._compact(text)
        if len(heard) < 4:
            return False
        return any((heard in s and len(heard) >= 0.6 * len(s)) or (len(s) >= 4 and s in heard)
                   for s, t in self._said if now - t < window_s)

    def _is_cancel(self, text: str) -> bool:
        return persona.is_cancel(text, tuple(self.settings.cancel_phrases), (self.ribbon_name,))

    async def _maybe_respond(self) -> None:
        active = self.queue.active()
        if active and active.text and not self._responding:
            await self._respond(active)

    async def _respond(self, turn: Turn) -> None:
        self._responding = True
        self._respond_task = asyncio.current_task()   # 관리자 "중단"이 이 작업을 멈춘다
        self._more = more = asyncio.Event()
        producer: Optional[asyncio.Task] = None
        kid = self._kid_for_channel(turn.channel)
        text = turn.text
        turn.text = ""  # 답하는 동안 들어오는 말은 여기 다시 쌓인다 (버리지 않는다)
        rc = self.store.config.ribbon if self.store else None
        max_sentences = rc.max_sentences if rc else 2
        history = self._history.setdefault(kid.id, [])
        try:
            await self._set_ribbon("thinking", kid.id)
            restarts = 0
            while True:
                messages = persona.build_messages(
                    kid if not kid.id.startswith("unknown_") else None, history, text,
                    name=rc.name if rc else "리본", extra=rc.persona_extra if rc else "",
                    max_sentences=max_sentences, promises=self._promises(kid),
                    knowledge=self._knowledge(kid, text))
                sentences: List[str] = []
                synth: List[asyncio.Task] = []   # 문장이 완성되는 즉시 합성을 시작한다 (pipelining)
                first_ready = asyncio.Event()
                producer = asyncio.create_task(
                    self._produce(messages, text, max_sentences, sentences, synth, first_ready))
                # 1) 인식 직후 즉시 반응 (LLM 을 기다리지 않는다). 다시 생각할 때는 하지 않는다
                if restarts == 0 and rc is not None and rc.ack_enabled:
                    await self._say(persona.acknowledge(text, call_name(kid)), kid.id, final=False, wait=True)
                    await self._set_ribbon("thinking", kid.id)
                # 2) 첫 문장을 기다린다. 늦으면 추임새. 그 사이 아이가 이어 말하면 합쳐서 다시 생각한다
                await self._wait_first(first_ready, more, kid.id, rc)
                if more.is_set() and turn.text and restarts < 3:
                    producer.cancel()
                    for t in synth:
                        t.cancel()
                    text = f"{text} {turn.text}"
                    turn.text = ""
                    more.clear()
                    restarts += 1
                    log.info("아이가 이어 말해서 다시 생각: %s", text)
                    continue
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
            self._maybe_learn(kid, text, " ".join(sentences), history[:-2])
        except Exception:
            log.exception("LLM 응답 실패")
            await self._say("미안, 잠깐 생각이 안 났어. 다시 말해줄래?", kid.id, final=True)
        finally:
            self._responding = False
            self._more = None
            if producer and not producer.done():
                producer.cancel()                     # 중단되면 LLM 스트림도 닫는다
        if turn.text and turn is self.queue.active():
            await self._respond(turn)                 # 리본이가 말하는 사이 아이가 더 말했다: 같은 차례로 이어서
            return
        self.queue.complete_active()
        await self._after_turn()

    async def _produce(self, messages: List[Dict[str, str]], text: str, max_sentences: int,
                       sentences: List[str], synth: List[asyncio.Task], first_ready: asyncio.Event) -> None:
        """LLM 을 흘려 받아 문장이 끝날 때마다 sentences 에 넣고 합성을 시작한다"""
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

    async def _wait_first(self, first_ready: asyncio.Event, more: asyncio.Event, kid_id: str, rc) -> None:
        """첫 문장이 준비되거나 아이가 이어 말할 때까지 기다린다. 오래 걸리면 추임새로 침묵을 메운다"""
        fillers = rc is None or rc.filler_enabled
        delay = rc.filler_delay_s if rc else 1.5
        n = 0
        while not first_ready.is_set() and not more.is_set():
            waits = [asyncio.create_task(first_ready.wait()), asyncio.create_task(more.wait())]
            done, pending = await asyncio.wait(waits, timeout=delay if fillers and n < 4 else None,
                                               return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            if done:
                return
            await self._say(persona.filler(n), kid_id, final=False, wait=True)
            await self._set_ribbon("thinking", kid_id)
            n += 1
            delay = rc.filler_interval_s if rc else 4.0

    async def _listen_cue(self, kid: KidInfo) -> None:
        """불렀을 때 "듣고 있어" 신호. 기본은 짧은 "띵" 소리라서 아이가 바로 이어 말할 수 있다"""
        rc = self.store.config.ribbon if self.store else None
        if rc is not None and rc.listen_cue == "voice":
            await self._say(persona.listening_prompt(call_name(kid)), kid.id, final=True)
            return
        self._barged = False
        self._hold_until = time.time() + 0.35         # 띵 소리(0.25초)가 마이크로 들어가는 것만 막는다
        self._last_spoken_at = time.time()           # 여기부터 "말 안 하면 끝내기" 시간을 잰다
        await self.broadcast({"type": "cue", "kind": "listen", "kid_id": kid.id})

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
            await self._say(persona.turn_prompt(call_name(kid)), kid.id, final=True)   # 누구 차례인지 이름으로

    async def _say(self, text: str, kid_id: Optional[str], final: bool,
                   audio: Optional[bytes] = None, wait: bool = True) -> None:
        """한 문장을 보낸다. audio 가 없으면 여기서 합성한다. wait=False 면 재생 완료를 기다리지 않고
        다음 문장을 바로 보낸다 (클라이언트가 순서대로 이어 재생). 마지막 문장은 wait=True 로 기다린다."""
        gen = self._stop_gen
        async with self._speak_lock:
            if gen != self._stop_gen:
                return                                # 기다리는 사이 관리자가 중단했다
            utt_id = f"u{next(_utt_ids)}"
            self._barged = False                       # 리본이가 다시 말한다: 에코 막기 다시
            log.info("리본> %s", text)
            self._said.append((self._compact(text), time.time()))
            await self._set_ribbon("speaking", kid_id)
            if audio is None:
                audio = await self._synth(text)
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
