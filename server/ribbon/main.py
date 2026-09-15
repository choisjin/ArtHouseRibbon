"""리본 서버 진입점.

실행:  cd server && uvicorn ribbon.main:app --host 0.0.0.0 --port 8765
WS:    /ws  (JSON 텍스트 프레임 + 오디오 바이너리 프레임)
정적:  client/dist 가 있으면 / 에서 서빙
"""
from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Dict, List, Set

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .audio.stream import ChannelProcessor
from .audio.wakeword import make_wakeword
from .config import settings
from .dialogue import DialogueManager
from .kids.registry import KidRegistry
from .providers.llm import make_llm
from .providers.stt import make_stt
from .providers.tts import make_tts

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ribbon.main")


class Hub:
    """접속한 클라이언트 관리와 브로드캐스트."""

    def __init__(self) -> None:
        self.clients: Dict[WebSocket, str] = {}  # ws -> role

    async def broadcast(self, message: dict, roles: Set[str] | None = None) -> None:
        data = json.dumps(message, ensure_ascii=False)
        dead: List[WebSocket] = []
        for ws, role in list(self.clients.items()):
            if roles and role not in roles:
                continue
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.pop(ws, None)


hub = Hub()
kids = KidRegistry.load(settings.kids_path())
llm = make_llm(settings)
stt = make_stt(settings)
tts = make_tts(settings)
dialogue = DialogueManager(settings, kids, llm, tts, hub.broadcast)
processors: Dict[int, ChannelProcessor] = {
    ch: ChannelProcessor(ch, settings, make_wakeword(settings)) for ch in range(settings.channels)
}


async def _ticker() -> None:
    while True:
        await asyncio.sleep(1.0)
        try:
            await dialogue.tick()
        except Exception:
            log.exception("tick 실패")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("kids=%d stt=%s llm=%s tts=%s wakeword=%s", len(kids.all()), settings.stt_provider,
             settings.llm_provider, settings.tts_provider, settings.wakeword_provider)
    task = asyncio.create_task(_ticker())
    yield
    task.cancel()


app = FastAPI(title="Ribbon", lifespan=lifespan)


@app.get("/api/state")
async def api_state():
    return JSONResponse(dialogue.snapshot().model_dump())


@app.get("/api/kids")
async def api_kids():
    return JSONResponse([k.model_dump() for k in kids.all()])


_tasks: Set[asyncio.Task] = set()


def _spawn(coro) -> None:
    """대화 이벤트는 TTS 완료(tts.done)를 기다리므로 WS 수신 루프와 분리해 실행한다.
    같은 루프에서 await 하면 tts.done 을 받지 못해 교착된다."""
    task = asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _transcribe_and_dispatch(channel: int, pcm: np.ndarray) -> None:
    text = await stt.transcribe(pcm, settings.sample_rate)
    if text:
        await dialogue.on_utterance(channel, text)


async def _handle_audio(channel: int, pcm: np.ndarray) -> None:
    proc = processors.get(channel)
    if proc is None:
        return
    for kind, payload in proc.feed(pcm):
        if kind == "wake":
            _spawn(dialogue.on_wake(channel))
        elif kind == "utterance" and payload is not None:
            _spawn(_transcribe_and_dispatch(channel, payload))


async def _handle_text(ws: WebSocket, msg: dict) -> None:
    t = msg.get("type")
    if t == "hello":
        hub.clients[ws] = msg.get("role", "unknown")
        await ws.send_text(json.dumps(dialogue.snapshot().model_dump(), ensure_ascii=False))
    elif t == "tts.done":
        dialogue.mark_spoken(msg.get("utterance_id", ""))
    elif t == "debug.wake":
        ch = int(msg.get("channel", 0))
        processors[ch].start_listening()
        _spawn(dialogue.on_wake(ch))
    elif t == "debug.utterance":
        _spawn(dialogue.on_utterance(int(msg.get("channel", 0)), str(msg.get("text", ""))))
    elif t == "kid.enter":
        _spawn(dialogue.on_kid_enter(str(msg.get("kid_id", ""))))
    elif t == "kid.leave":
        _spawn(dialogue.on_kid_leave(str(msg.get("kid_id", ""))))
    elif t == "face.positions":
        # TV 위 카메라 클라이언트 -> TV 화면(시선 추적)으로 그대로 중계
        await hub.broadcast(msg, roles={"tv"})
    else:
        log.debug("unknown message: %s", t)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    hub.clients[ws] = "unknown"
    try:
        while True:
            frame = await ws.receive()
            if frame.get("bytes") is not None:
                data: bytes = frame["bytes"]
                if len(data) < 3:
                    continue
                channel = data[0]
                pcm = np.frombuffer(data[2:], dtype="<i2")
                await _handle_audio(channel, pcm)
            elif frame.get("text") is not None:
                try:
                    msg = json.loads(frame["text"])
                except json.JSONDecodeError:
                    continue
                await _handle_text(ws, msg)
            elif frame.get("type") == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.pop(ws, None)


dist = settings.client_dist_path()
if dist.exists():
    app.mount("/", StaticFiles(directory=str(dist), html=True), name="client")
