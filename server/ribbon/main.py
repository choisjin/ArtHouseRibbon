"""리본 서버 진입점.

실행:  cd server && uvicorn ribbon.main:app --host 0.0.0.0 --port 8765
WS:    /ws  (JSON 텍스트 프레임 + 오디오 바이너리 프레임)
정적:  client/dist 가 있으면 / 에서 서빙
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from contextlib import asynccontextmanager
from typing import Dict, List, Set

import numpy as np
from fastapi import Body, FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .audio.stream import ChannelProcessor
from .audio.wakeword import make_wakeword
from .config import settings
from .dialogue import DialogueManager
from .kids.registry import KidRegistry
from .providers.llm import make_llm
from .providers.stt import make_stt
from .providers.tts import configure_tts, make_tts
from .room_store import RoomStore
from .settings_store import ConfigStore
from pydantic import ValidationError

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
store = ConfigStore(settings.settings_path())
room = RoomStore(settings.room_path())
llm = make_llm(settings)
stt = make_stt(settings)
tts = make_tts(settings)
configure_tts(tts, store.config.ribbon.voice, store.config.ribbon.speed, store.config.ribbon.steps,
              store.config.ribbon.pitch)
dialogue = DialogueManager(settings, kids, llm, tts, hub.broadcast, store, room)
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
    log.info("kids=%d stt=%s llm=%s:%s tts=%s wakeword=%s", len(kids.all()), settings.stt_provider,
             settings.llm_provider, settings.llm_model, settings.tts_provider, settings.wakeword_provider)
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


# ---------- 관리자 API (같은 LAN 안에서만 쓰는 전제. 인증은 아직 없음) ----------

@app.post("/api/kids")
@app.put("/api/kids/{kid_id}")
async def api_kid_upsert(kid_id: str | None = None, data: dict = Body(...)):
    if kid_id:
        data["id"] = kid_id
    if not str(data.get("name", "")).strip():
        raise HTTPException(400, "이름이 필요합니다")
    kid = kids.upsert(data)
    await dialogue.notify_config_changed()
    return JSONResponse(kid.model_dump())


@app.delete("/api/kids/{kid_id}")
async def api_kid_delete(kid_id: str):
    if not kids.remove(kid_id):
        raise HTTPException(404, "없는 아이")
    await dialogue.notify_config_changed()
    return JSONResponse({"ok": True})


@app.get("/api/config")
async def api_config_get():
    return JSONResponse(store.config.model_dump())


@app.put("/api/config/ribbon")
async def api_config_ribbon(data: dict = Body(...)):
    rc = store.update_ribbon(data)
    configure_tts(tts, rc.voice, rc.speed, rc.steps, rc.pitch)
    log.info("ribbon config saved: voice=%s speed=%s steps=%s pitch=%s name=%s (tts=%s)",
             rc.voice, rc.speed, rc.steps, rc.pitch, rc.name, settings.tts_provider)
    await dialogue.notify_config_changed()
    return JSONResponse(rc.model_dump())


@app.get("/api/room")
async def api_room_get():
    return JSONResponse(room.spec.model_dump())


@app.put("/api/room")
async def api_room_put(data: dict = Body(...)):
    try:
        spec = room.replace(data)
    except ValidationError as e:
        raise HTTPException(400, f"방 설정 형식 오류: {e.errors()[:3]}")
    await dialogue.notify_config_changed()
    log.info("room saved: %d layers", len(spec.layers))
    return JSONResponse(spec.model_dump())


@app.post("/api/room/reset")
async def api_room_reset():
    spec = room.reset()
    await dialogue.notify_config_changed()
    return JSONResponse(spec.model_dump())


@app.post("/api/tts/preview")
async def api_tts_preview(data: dict = Body(...)):
    """관리자 페이지 '미리 듣기'. 저장하지 않고 지정한 목소리로 한 문장을 합성한다."""
    text = str(data.get("text") or f"안녕, 나는 {store.config.ribbon.name}이야. 오늘은 무슨 그림을 그렸어?")
    if not hasattr(tts, "configure"):
        raise HTTPException(
            400, f"현재 TTS 제공자({settings.tts_provider})는 목소리·속도·피치 선택을 지원하지 않습니다. "
                 ".env 에서 RIBBON_TTS_PROVIDER=supertonic 으로 바꾸고 서버를 재시작하세요.")
    log.info("tts preview voice=%s speed=%s steps=%s pitch=%s", data.get("voice"), data.get("speed"),
             data.get("steps"), data.get("pitch"))
    kwargs = {}
    if data.get("voice"):
        kwargs["voice"] = str(data["voice"])
    if data.get("speed"):
        kwargs["speed"] = float(data["speed"])
    if data.get("steps"):
        kwargs["steps"] = int(data["steps"])
    if data.get("pitch") is not None:
        kwargs["pitch"] = float(data["pitch"])
    try:
        wav = await tts.synthesize(text, **kwargs) if kwargs else await tts.synthesize(text)
    except TypeError:  # browser/mac_say 제공자는 인자를 받지 않는다
        wav = await tts.synthesize(text)
    if not wav:
        raise HTTPException(400, "이 TTS 제공자는 서버 합성을 지원하지 않습니다 (browser 모드)")
    return Response(content=wav, media_type="audio/wav")


@app.get("/api/assets")
async def api_assets_list():
    d = settings.assets_path()
    files = sorted(p.name for p in d.glob("*") if p.is_file()) if d.exists() else []
    return JSONResponse([{"name": n, "url": f"/uploads/{n}"} for n in files])


@app.post("/api/assets")
async def api_assets_upload(file: UploadFile = File(...)):
    """PNG 스프라이트 업로드. 아바타/리본이 sprite_url 로 쓴다."""
    if not (file.content_type or "").startswith("image/"):
        raise HTTPException(400, "이미지 파일만 올릴 수 있습니다")
    d = settings.assets_path()
    d.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", file.filename or "sprite.png")
    name = f"{uuid.uuid4().hex[:8]}_{safe}"
    (d / name).write_bytes(await file.read())
    return JSONResponse({"name": name, "url": f"/uploads/{name}"})


@app.delete("/api/assets/{name}")
async def api_assets_delete(name: str):
    p = settings.assets_path() / re.sub(r"[^A-Za-z0-9_.-]+", "_", name)
    if not p.exists():
        raise HTTPException(404, "없는 파일")
    p.unlink()
    return JSONResponse({"ok": True})


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


assets_dir = settings.assets_path()
assets_dir.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(assets_dir)), name="uploads")  # /assets 는 Vite 번들이 쓴다

dist = settings.client_dist_path()
if dist.exists():
    app.mount("/", StaticFiles(directory=str(dist), html=True), name="client")
