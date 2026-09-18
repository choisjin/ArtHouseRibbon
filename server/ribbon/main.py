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
from typing import Any, Dict, List, Set

import numpy as np
from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
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
from .settings_store import ConfigStore
from .world_render import WorldRenderer
from .world_store import WorldStore

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
world = WorldStore(settings.world_catalog_path(), settings.world_path(), settings.artworks_path())
llm = make_llm(settings)
stt = make_stt(settings)
tts = make_tts(settings)
configure_tts(tts, store.config.ribbon.voice, store.config.ribbon.speed, store.config.ribbon.steps,
              store.config.ribbon.pitch)
dialogue = DialogueManager(settings, kids, llm, tts, hub.broadcast, store, world)
renderer = WorldRenderer(world, settings.blender_exe, settings.render_pct, settings.render_samples,
                         on_change=dialogue.notify_config_changed)
world.render_info = renderer.info
world.render_busy = lambda: renderer.running
world.kid_ids = lambda: [k.id for k in kids.all()]
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
    log.info("blender=%s (배경 자동 렌더 %s)", renderer.blender or "없음", "켬" if settings.render_auto else "끔")
    if renderer.available and settings.render_auto:
        # 렌더가 없거나 배치가 바뀐 방은 켜질 때 한 번 렌더
        for r in world.render_rooms():
            info = renderer.info(r)
            if info is None or info["stale"]:
                renderer.request(r)
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
    room = world.kid_room(kid_id)
    if not kids.remove(kid_id):
        raise HTTPException(404, "없는 아이")
    world.forget_kid_room(room)          # 전시실에 걸어 둔 그림 목록도 같이 지운다 (사진 파일은 남는다)
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


# ---------- 3D 맵 (방 배치 · 그림). 편집기: /?mode=editor ----------

def _room_param(room: str | None) -> str:
    try:
        return world.check_room(room or world.active)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/world")
async def api_world_get(room: str | None = None):
    r = _room_param(room)
    return JSONResponse({"room": r, "active": world.active, "layout": world.layout(r), "catalog": world.catalog,
                         "has_layout_file": world.has_layout(r), "artworks": world.artworks(),
                         "render": renderer.status()})


@app.put("/api/world/layout")
async def api_world_layout_put(room: str, data: dict = Body(...)):
    r = _room_param(room)
    try:
        world.save_layout(r, data)
    except (ValueError, TypeError, KeyError) as e:
        raise HTTPException(400, str(e))
    # 아이 전시실은 배경을 같이 쓰므로 다시 렌더하지 않는다 (그림은 TV 가 실시간으로 그린다)
    rendering = bool(settings.render_auto and world.kid_of(r) is None and renderer.request(r))
    if r == world.active:
        await dialogue.notify_config_changed()
    return JSONResponse({"ok": True, "rendering": rendering})


@app.post("/api/world/reset")
async def api_world_reset(room: str):
    r = _room_param(room)
    world.reset_layout(r)
    if settings.render_auto:
        renderer.request(r)
    if r == world.active:
        await dialogue.notify_config_changed()
    return JSONResponse({"ok": True, "layout": world.layout(r)})


@app.get("/api/world/render")
async def api_world_render_status():
    return JSONResponse({"render": renderer.status(), "log": renderer.log_tail()})


@app.post("/api/world/render")
async def api_world_render(room: str):
    """TV 배경 다시 렌더 (편집기의 '배경 렌더' 버튼)"""
    r = _room_param(room)
    if not renderer.request(r):
        raise HTTPException(400, "블렌더를 찾지 못했습니다. 맥미니에 Blender 를 설치하거나 .env 에 RIBBON_BLENDER_EXE 를 지정하세요")
    return JSONResponse({"ok": True, "render": renderer.status()})


@app.put("/api/world/active")
async def api_world_active(data: dict = Body(...)):
    r = _room_param(str(data.get("room") or ""))
    world.set_active(r)
    log.info("TV room -> %s", r)
    await dialogue.notify_config_changed()
    return JSONResponse({"ok": True, "active": r})


@app.get("/api/kids/{kid_id}/gallery")
async def api_kid_gallery(kid_id: str):
    """아이 전시실: 걸린 그림이 든 배치 + 그 아이가 올린 그림 목록 + 벽 정보(카탈로그)"""
    if not kids.get(kid_id):
        raise HTTPException(404, "없는 아이입니다")
    room = world.kid_room(kid_id)
    return JSONResponse({"room": room, "kid": kids.get(kid_id).model_dump(), "layout": world.layout(room),
                         "artworks": world.artworks(kid_id), "catalog": world.catalog})


@app.post("/api/world/visit")
async def api_world_visit(data: dict = Body(...)):
    """TV 가 잠깐 아이 전시실을 보러 간다. seconds 뒤에 원래 방(보통 교실)으로 돌아온다.
    seconds 가 0 이면 돌아오지 않는다 (계속 그 방)."""
    kid_id = str(data.get("kid_id") or "")
    room = world.kid_room(kid_id) if kid_id else str(data.get("room") or "")
    seconds = float(data.get("seconds", 60))
    try:
        world.check_room(room)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await _visit(room, seconds)
    return JSONResponse({"ok": True, "active": world.active, "seconds": seconds})


_visit_back: Dict[str, Any] = {"task": None, "room": None}


async def _visit(room: str, seconds: float) -> None:
    task = _visit_back.get("task")
    if task and not task.done():
        task.cancel()
    back = _visit_back.get("room") or world.active     # 나들이 중에 또 부르면 원래 방은 그대로
    if world.kid_of(back):
        back = world.rooms()[0] if world.rooms() else "classroom"
    world.set_active(room)
    log.info("TV 전시실 나들이: %s (%s초 뒤 %s 로)", room, seconds, back)
    await dialogue.notify_config_changed()
    if seconds <= 0:
        _visit_back.update(task=None, room=None)
        return
    _visit_back["room"] = back

    async def come_back() -> None:
        try:
            await asyncio.sleep(seconds)
        except asyncio.CancelledError:
            return
        world.set_active(back)
        _visit_back.update(task=None, room=None)
        log.info("TV 나들이 끝: %s 로 돌아옴", back)
        await dialogue.notify_config_changed()

    _visit_back["task"] = asyncio.create_task(come_back())


@app.get("/api/artworks")
async def api_artworks(kid_id: str | None = None):
    return JSONResponse({"artworks": world.artworks(kid_id)})


@app.post("/api/artworks")
async def api_artwork_upload(data: dict = Body(...)):
    """{"name", "data": dataURL, "width", "height", "kid_id"} → data/artworks/"""
    try:
        entry, new = world.add_artwork(data)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    return JSONResponse({"ok": True, "artwork": entry, "new": new})


@app.post("/api/artworks/delete")
async def api_artwork_delete(data: dict = Body(...)):
    try:
        world.delete_artwork(str(data.get("file", "")))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return JSONResponse({"ok": True})


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


_tasks: Set[asyncio.Task] = set()


def _spawn(coro) -> None:
    """대화 이벤트는 TTS 완료(tts.done)를 기다리므로 WS 수신 루프와 분리해 실행한다.
    같은 루프에서 await 하면 tts.done 을 받지 못해 교착된다."""
    task = asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _transcribe_and_dispatch(channel: int, pcm: np.ndarray) -> None:
    try:
        text = await stt.transcribe(pcm, settings.sample_rate)
    except Exception:
        log.exception("STT 실패 (ch=%s, %.1fs)", channel, len(pcm) / settings.sample_rate)
        return
    if text:
        await dialogue.on_utterance(channel, text)


_audio_seen: Dict[int, float] = {}


async def _handle_audio(channel: int, pcm: np.ndarray) -> None:
    now = asyncio.get_running_loop().time()
    if now - _audio_seen.get(channel, -1e9) > 60:
        log.info("마이크 소리 들어옴: 채널 %d", channel)   # 처음, 또는 1분 넘게 끊겼다가 다시 들어올 때
    _audio_seen[channel] = now
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
        if hub.clients[ws] == "mic":
            log.info("마이크 화면 연결됨 (%s)", ws.client.host if ws.client else "?")
        await ws.send_text(json.dumps(dialogue.snapshot().model_dump(), ensure_ascii=False))
    elif t == "tts.done":
        dialogue.mark_spoken(msg.get("utterance_id", ""))
    elif t == "debug.wake":
        ch = int(msg.get("channel", 0))
        processors[ch].start_listening()
        _spawn(dialogue.on_wake(ch))
    elif t == "client.log":
        log.warning("[%s %s] %s", hub.clients.get(ws, "?"), ws.client.host if ws.client else "?",
                    str(msg.get("text", ""))[:300])
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


art_dir = settings.artworks_path()
art_dir.mkdir(parents=True, exist_ok=True)
app.mount("/artworks", StaticFiles(directory=str(art_dir)), name="artworks")  # 배치의 image = "artworks/<파일>"
render_dir = renderer.dir
render_dir.mkdir(parents=True, exist_ok=True)
app.mount("/world-render", StaticFiles(directory=str(render_dir)), name="world-render")   # TV 배경 렌더

dist = settings.client_dist_path()
if dist.exists():
    app.mount("/", StaticFiles(directory=str(dist), html=True), name="client")
