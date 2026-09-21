"""리본 서버 진입점.

실행:  cd server && uvicorn ribbon.main:app --host 0.0.0.0 --port 8765
WS:    /ws  (JSON 텍스트 프레임 + 오디오 바이너리 프레임)
정적:  client/dist 가 있으면 / 에서 서빙
"""
from __future__ import annotations

import asyncio
import base64
import datetime as dt
import json
import logging
import mimetypes
from urllib.parse import quote
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional, Set

import numpy as np
from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import auth as auth_mod
from .audio import recorder
from .chatlog import ChatLog
from .audio.bargein import BargeIn
from .audio.button import ButtonCall, DjiButton
from .audio.stream import ChannelProcessor
from .audio.wakeword import make_wakeword
from .config import settings
from .cutout import Cutout, CutoutError
from . import gallery_export
from .devices import DeviceBoard
from .dialogue import DialogueManager
from .kids.registry import KidRegistry
from .memory import MemoryStore
from .music import MusicError, SpotifyAccount
from .music_intent import MusicControl
from .knowledge.pokedex import Pokedex
from .providers import llm as llm_mod
from .providers.llm import make_llm
from .providers.stt import make_stt
from .providers.tts import configure_tts, make_tts
from . import schedule as sched
from .settings_store import ConfigStore
from .voices import list_voices
from .world_render import WorldRenderer
from .world_store import WorldStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ribbon.main")


class Hub:
    """접속한 클라이언트 관리와 브로드캐스트."""

    def __init__(self) -> None:
        self.clients: Dict[WebSocket, str] = {}  # ws -> role
        self.ids: Dict[WebSocket, str] = {}      # ws -> client_id (브라우저마다 고정, ws.ts clientId)

    def agent(self, ws: WebSocket) -> str:
        """장치를 가진 화면 하나: "브라우저 id/역할". 같은 크롬에서 마이크 화면과 TV 를 같이 열어도 나뉜다"""
        return f"{self.ids.get(ws, '')}/{self.clients.get(ws, '?')}"

    async def send_to(self, agent: str, message: dict) -> int:
        """그 화면(agent)의 연결들에만 보낸다. 보낸 수를 돌려준다"""
        data = json.dumps(message, ensure_ascii=False)
        n = 0
        for ws in list(self.ids):
            if self.agent(ws) != agent:
                continue
            try:
                await ws.send_text(data)
                n += 1
            except Exception:
                pass
        return n

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
devices = DeviceBoard()
kids = KidRegistry.load(settings.kids_path())
store = ConfigStore(settings.settings_path())
memory = MemoryStore(settings.memory_path(), store.config.ribbon.memory_max_per_kid)
pokedex = Pokedex(settings.pokedex_path(), settings.pokedex_path().parent / "pokemon_looks_cache.json")
schedule = sched.ScheduleStore(settings.schedule_path())
auth = auth_mod.AuthStore(settings.users_path(), settings.sessions_path())
chat_log = ChatLog(settings.logs_path())


async def broadcast_and_log(message: dict) -> None:
    """오가는 말을 화면들에 보내면서 대화 로그에도 남긴다 (관리자 '로그' 탭, data/logs/날짜.jsonl)"""
    chat_log.note(message, lambda kid_id: (kids.get(kid_id).name if kid_id and kids.get(kid_id) else ""),
                  store.config.ribbon.name)
    await hub.broadcast(message)
spotify = SpotifyAccount(settings.music_auth_path())
music = MusicControl(spotify, store)
spotify.market = store.config.music.market   # 어느 나라 카탈로그로 찾을지 (제목 언어)
world = WorldStore(settings.world_catalog_path(), settings.world_path(), settings.artworks_path())
cutout = Cutout(settings.cutout_model_path(), settings.cutout_model_url)   # 작품 사진 배경 지우기
# 대화 모델: 관리자 설정 탭에서 고른 값(settings.json)이 .env 보다 앞선다
store.seed_llm(settings.llm_provider, settings.llm_base_url, settings.llm_model)
llm_settings = llm_mod.resolve(settings, **store.config.llm.model_dump())
llm = make_llm(llm_settings)
stt = make_stt(settings)
tts = make_tts(settings)
configure_tts(tts, store.config.ribbon.voice, store.config.ribbon.speed, store.config.ribbon.steps,
              store.config.ribbon.pitch)
dialogue = DialogueManager(settings, kids, llm, tts, broadcast_and_log, store, world, memory, pokedex, music)
music.on_config = dialogue.notify_config_changed   # 말로 음량을 바꾸면 재생 화면에 알린다
renderer = WorldRenderer(world, settings.blender_exe, settings.render_pct, settings.render_samples,
                         on_change=dialogue.notify_config_changed)
world.render_info = renderer.info
world.render_busy = lambda: renderer.running
world.kid_ids = lambda: [k.id for k in kids.all()]
processors: Dict[int, ChannelProcessor] = {
    ch: ChannelProcessor(ch, settings, make_wakeword(settings)) for ch in range(settings.channels)
}
button_call = ButtonCall(processors)   # 호출 버튼 뒤 먼저 말한 채널 고르기
if dialogue.quiz:   # MLX 로 만든 게임 표지: 맥미니에서 새로 만든 것(data) -> 저장소에 넣어 둔 것(client public -> dist)
    dialogue.quiz.thumbs_dirs = [settings.pokedex_path().parent / "game_thumbs", settings.client_dist_path() / "game_thumbs"]


async def _ticker() -> None:
    while True:
        await asyncio.sleep(1.0)
        try:
            await dialogue.tick()
        except Exception:
            log.exception("tick 실패")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("kids=%d stt=%s llm=%s:%s (%s) tts=%s wakeword=%s", len(kids.all()), settings.stt_provider,
             llm_settings.llm_provider, llm_settings.llm_model, llm_settings.llm_base_url,
             settings.tts_provider, settings.wakeword_provider)
    log.info("포켓몬 도감: %s", f"{len(pokedex)}마리" if len(pokedex) else "없음 (python tools/fetch_pokedex.py 로 받기)")
    log.info("blender=%s (배경 자동 렌더 %s)", renderer.blender or "없음", "켬" if settings.render_auto else "끔")
    if renderer.available and settings.render_auto:
        # 렌더가 없거나 배치가 바뀐 방은 켜질 때 한 번 렌더
        for r in world.render_rooms():
            info = renderer.info(r)
            if info is None or info["stale"]:
                renderer.request(r)
    task = asyncio.create_task(_ticker())
    _spawn(dialogue.prewarm())                   # 버튼 "지금 말해줘." 를 미리 합성
    button = None
    if settings.call_button_hid:
        loop = asyncio.get_running_loop()
        button = DjiButton(lambda: loop.call_soon_threadsafe(_spawn, _on_button()))
        button.start()
    yield
    task.cancel()
    await spotify.close()
    if button:
        button.stop()


app = FastAPI(title="Ribbon", lifespan=lifespan)


@app.get("/api/state")
async def api_state():
    return JSONResponse(dialogue.snapshot().model_dump())


# ---------- 로그인 · 회원가입 · 권한 (auth.py) ----------
# 아무도 가입하지 않았으면 전부 열려 있다 (첫 가입자가 관리자가 된다).
# 가입한 사람이 생기면: 아래 MEMBER_* 는 로그인한 사람, 나머지 /api/ 는 관리자만.

def _session_user(request: Request) -> Optional[Dict[str, Any]]:
    return auth.user_for(request.cookies.get(auth_mod.COOKIE))


def _allowed(request: Request, user: Optional[Dict[str, Any]]) -> bool:
    if auth.empty:
        return True                                   # 아직 아무도 가입하지 않았다 (첫 가입자가 관리자)
    return auth_mod.permitted(request.url.path, request.method, user["role"] if user else None)


@app.middleware("http")
async def auth_guard(request: Request, call_next):
    user = _session_user(request)
    request.state.user = user
    if not _allowed(request, user):
        return JSONResponse({"detail": "로그인이 필요합니다" if user is None else "관리자만 쓸 수 있습니다"},
                            status_code=401 if user is None else 403)
    return await call_next(request)


def _set_cookie(response: JSONResponse, token: str, request: Request) -> None:
    secure = request.url.scheme == "https" or settings.public_url.startswith("https")
    response.set_cookie(auth_mod.COOKIE, token, max_age=auth_mod.SESSION_DAYS * 86400,
                        httponly=True, samesite="lax", secure=secure, path="/")


def _require_admin(request: Request) -> Dict[str, Any]:
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(401, "로그인이 필요합니다")
    if user["role"] != "admin":
        raise HTTPException(403, "관리자만 쓸 수 있습니다")
    return user


@app.get("/api/auth/me")
async def api_auth_me(request: Request):
    """로그인 상태. needs_setup 이면 아직 아무도 없으니 첫 가입자가 관리자가 된다"""
    user = getattr(request.state, "user", None)
    return JSONResponse({"user": auth.public(user) if user else None, "needs_setup": auth.empty})


@app.post("/api/auth/signup")
async def api_auth_signup(request: Request, data: dict = Body(...)):
    """회원가입. 첫 사람은 관리자, 그 뒤는 member (관리자가 올려 준다)"""
    try:
        user = auth.signup(str(data.get("email") or ""), str(data.get("password") or ""),
                           str(data.get("name") or ""))
    except ValueError as e:
        raise HTTPException(400, str(e))
    res = JSONResponse({"user": auth.public(user)})
    _set_cookie(res, auth.start_session(user), request)
    return res


@app.post("/api/auth/login")
async def api_auth_login(request: Request, data: dict = Body(...)):
    try:
        user = auth.login(str(data.get("email") or ""), str(data.get("password") or ""))
    except ValueError as e:
        raise HTTPException(401, str(e))
    log.info("로그인: %s (%s)", user["email"], user["role"])
    res = JSONResponse({"user": auth.public(user)})
    _set_cookie(res, auth.start_session(user), request)
    return res


@app.post("/api/auth/logout")
async def api_auth_logout(request: Request):
    auth.end_session(request.cookies.get(auth_mod.COOKIE))
    res = JSONResponse({"ok": True})
    res.delete_cookie(auth_mod.COOKIE, path="/")
    return res


@app.post("/api/auth/password")
async def api_auth_password(request: Request, data: dict = Body(...)):
    """내 비밀번호 바꾸기 (지금 비밀번호를 한 번 더 확인한다)"""
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(401, "로그인이 필요합니다")
    try:
        auth.login(user["email"], str(data.get("current") or ""))
        auth.set_password(user["id"], str(data.get("password") or ""))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return JSONResponse({"ok": True})


@app.get("/api/auth/users")
async def api_auth_users(request: Request):
    _require_admin(request)
    return JSONResponse({"users": auth.list_users()})


@app.put("/api/auth/users/{uid}")
async def api_auth_user_role(uid: str, request: Request, data: dict = Body(...)):
    """권한 주기·거두기 (admin | member)"""
    me = _require_admin(request)
    try:
        user = auth.set_role(uid, str(data.get("role") or ""))
    except ValueError as e:
        raise HTTPException(400, str(e))
    log.info("권한 바꿈: %s -> %s (%s 가)", user["email"], user["role"], me["email"])
    return JSONResponse({"user": auth.public(user)})


@app.delete("/api/auth/users/{uid}")
async def api_auth_user_delete(uid: str, request: Request):
    me = _require_admin(request)
    if uid == me["id"]:
        raise HTTPException(400, "자기 계정은 지울 수 없습니다")
    try:
        auth.remove(uid)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return JSONResponse({"ok": True})


@app.api_route("/api/call", methods=["GET", "POST"])
async def api_call(token: str = ""):
    """주소로 리본이 부르기 (호출 버튼과 같다). 폰 매크로 앱(MacroDroid·Tasker)이 DJI 버튼=볼륨키를 잡아
    이 주소를 부르면 된다. 로그인 대신 설정의 호출 토큰으로 확인한다"""
    global _last_tv_call
    want = store.config.ribbon.call_token
    if not want or token != want:
        raise HTTPException(403, "호출 토큰이 맞지 않습니다")
    now = asyncio.get_running_loop().time()
    if now - _last_tv_call < 1.5:
        return JSONResponse({"ok": True, "skipped": "연달아 누름"})
    _last_tv_call = now
    log.info("주소로 호출 (/api/call)")
    _spawn(_on_button())
    return JSONResponse({"ok": True})


@app.get("/api/logs/days")
async def api_log_days():
    """기록이 있는 날짜들 (최근 것부터)"""
    return JSONResponse({"days": chat_log.days()})


@app.get("/api/logs")
async def api_logs(date: str = "", limit: int = 1000):
    """그날의 대화 기록 (관리자 '로그' 탭)"""
    return JSONResponse({"date": date or dt.date.today().isoformat(), "rows": chat_log.read(date or None, limit)})


@app.get("/api/net")
async def api_net(request: Request):
    """이 서버에 같은 와이파이에서 접속할 주소 (관리자 화면이 QR 로 보여 준다 -> 폰으로 작품 찍어 보내기)"""
    import socket
    port = request.url.port or 8765
    ips = set()
    try:                       # 밖으로 나가는 경로의 내 주소 (와이파이 랜카드)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    urls = [f"http://{ip}:{port}/" for ip in sorted(ips) if not ip.startswith("127.")]
    if settings.public_url:
        urls.insert(0, settings.public_url.rstrip("/") + "/")   # 도메인이 있으면 그 주소를 먼저 (https = 폰 카메라도 열린다)
    return JSONResponse({"urls": urls, "port": port, "public": settings.public_url.rstrip("/")})


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
    for slot in data.get("schedule") or []:
        if not (sched.valid_time(str(slot.get("start"))) and sched.valid_time(str(slot.get("end")))
                and str(slot["start"]) < str(slot["end"]) and 0 <= int(slot.get("day", -1)) <= 6):
            raise HTTPException(400, f"수업 시간이 잘못됐습니다: {slot}")
    try:
        kid = kids.upsert(data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await dialogue.notify_config_changed()
    return JSONResponse(kid.model_dump())


@app.delete("/api/kids/{kid_id}")
async def api_kid_delete(kid_id: str):
    room = world.kid_room(kid_id)
    if not kids.remove(kid_id):
        raise HTTPException(404, "없는 아이")
    world.forget_kid_room(room)          # 전시실에 걸어 둔 그림 목록도 같이 지운다 (사진 파일은 남는다)
    schedule.drop_kid(kid_id)
    memory.forget_kid(kid_id)            # 그 아이와 한 약속
    await dialogue.notify_config_changed()
    return JSONResponse({"ok": True})


# ---------- 포켓몬 그림 (포켓몬 맞추기 게임) ----------
_IMG_URL = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/{}.png"


@app.get("/api/pokemon/{pid}/image")
async def api_pokemon_image(pid: int):
    """공식 그림. 처음 한 번 받아 data/pokemon_img/ 에 두고 다음부터는 그 파일 (인터넷이 끊겨도 본 것은 나온다)"""
    from fastapi.responses import FileResponse
    import httpx
    if not 1 <= pid <= 2000:
        raise HTTPException(404, "없는 번호")
    folder = settings.pokedex_path().parent / "pokemon_img"
    path = folder / f"{pid}.png"
    if not path.exists():
        try:
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as c:
                r = await c.get(_IMG_URL.format(pid))
                r.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(502, f"그림을 받지 못했습니다: {e}")
        folder.mkdir(parents=True, exist_ok=True)
        path.write_bytes(r.content)
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "max-age=86400"})


@app.get("/api/game/thumb/{mode}")
async def api_game_thumb(mode: str):
    """게임 고르기 화면의 썸네일 (tools/make_game_thumbs.py 가 맥미니 MLX 로 만든 data/game_thumbs/*.png)"""
    from fastapi.responses import FileResponse
    if mode not in ("describe", "image", "peek"):
        raise HTTPException(404, "없는 게임")
    path = dialogue.quiz.thumb_file(mode) if dialogue.quiz else None
    if path is None:
        # 아직 안 만들었으면 포켓몬 공식 그림으로 (피카츄 / 이브이 / 팬텀)
        from fastapi.responses import RedirectResponse
        return RedirectResponse(f"/api/pokemon/{ {'describe': 25, 'image': 133, 'peek': 94}[mode] }/image")
    media = "image/png" if path.suffix == ".png" else "image/jpeg"
    return FileResponse(path, media_type=media, headers={"Cache-Control": "no-cache"})


# ---------- 리본이가 기억하는 약속 (memory.py) ----------

@app.get("/api/memory")
async def api_memory_list(kid_id: str | None = None, common: bool = False):
    """kid_id 면 그 아이 약속, common=true 면 모든 아이 공통 약속, 둘 다 없으면 전부"""
    return JSONResponse([r.model_dump() for r in memory.list(kid_id, only_global=common)])


@app.post("/api/memory")
async def api_memory_add(data: dict = Body(...)):
    """관리자가 직접 적는 약속. kid_id 가 없으면 모든 아이 공통"""
    memory.max_per_kid = store.config.ribbon.memory_max_per_kid
    rule = memory.add(str(data.get("text") or ""), data.get("kid_id") or None, by="admin")
    if rule is None:
        raise HTTPException(400, "비어 있거나 이미 있는 약속입니다")
    return JSONResponse(rule.model_dump())


@app.put("/api/memory/{rule_id}")
async def api_memory_update(rule_id: str, data: dict = Body(...)):
    """글 고치기, 또는 kid_id=null 로 모든 아이 공통으로 올리기"""
    rule = memory.update(rule_id, data)
    if rule is None:
        raise HTTPException(404, "없는 약속")
    return JSONResponse(rule.model_dump())


@app.delete("/api/memory/{rule_id}")
async def api_memory_delete(rule_id: str):
    if not memory.remove(rule_id):
        raise HTTPException(404, "없는 약속")
    return JSONResponse({"ok": True})


@app.get("/api/config")
async def api_config_get():
    return JSONResponse(store.config.model_dump())


@app.put("/api/config/character/{cid}")
async def api_config_character(cid: str, data: dict = Body(...)):
    """캐릭터 프로필(이름·성격·소개·목소리·겉모습). 주인공이면 대화·TV 에 바로 반영된다"""
    try:
        prof = store.update_character(cid, data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    rc = store.config.ribbon
    configure_tts(tts, rc.voice, rc.speed, rc.steps, rc.pitch)
    log.info("character %s saved: name=%s voice=%s", cid, prof.name, prof.voice)
    await dialogue.notify_config_changed()
    return JSONResponse(prof.model_dump())


@app.put("/api/config/ribbon")
async def api_config_ribbon(data: dict = Body(...)):
    rc = store.update_ribbon(data)
    configure_tts(tts, rc.voice, rc.speed, rc.steps, rc.pitch)
    log.info("ribbon config saved: voice=%s speed=%s steps=%s pitch=%s name=%s (tts=%s)",
             rc.voice, rc.speed, rc.steps, rc.pitch, rc.name, settings.tts_provider)
    await dialogue.notify_config_changed()
    return JSONResponse(rc.model_dump())


# ---------- 대화 모델 (관리자 '설정' 탭) ----------

@app.get("/api/llm/models")
async def api_llm_models(provider: str, base_url: str = ""):
    """그 서버에 있는 대화 모델 목록. 서버가 안 켜져 있으면 ok=false 와 이유"""
    if provider == "mock":
        return JSONResponse({"ok": True, "models": []})
    try:
        return JSONResponse({"ok": True, "models": await llm_mod.list_models(provider, base_url)})
    except Exception as e:  # noqa: BLE001 - 연결 실패는 화면에 이유를 보인다
        return JSONResponse({"ok": False, "error": f"{type(e).__name__}: {e}"})


@app.put("/api/config/llm")
async def api_config_llm(data: dict = Body(...)):
    """대화 모델 바꾸기. 다음 답부터 새 모델을 쓴다 (하던 답은 옛 모델로 끝낸다)"""
    global llm_settings
    cfg = store.update_llm(data)
    llm_settings = llm_mod.resolve(settings, **cfg.model_dump())
    old, dialogue.llm = dialogue.llm, make_llm(llm_settings)
    _spawn(llm_mod.close_later(old))
    log.info("대화 모델 바꿈: %s:%s (%s)", llm_settings.llm_provider, llm_settings.llm_model, llm_settings.llm_base_url)
    await dialogue.notify_config_changed()
    return JSONResponse(cfg.model_dump())


@app.post("/api/llm/test")
async def api_llm_test():
    """지금 대화 모델에 짧게 물어본다 (첫 글자까지 걸린 시간, 전체 시간, 답)"""
    from .persona import ribbon as persona_mod
    rc = store.config.ribbon
    messages = persona_mod.build_messages(None, [], "안녕! 한 문장으로 인사해 줘.", name=rc.name, extra=rc.persona_extra)
    t0 = asyncio.get_running_loop().time()
    first, text = None, ""
    try:
        async for d in dialogue.llm.stream(messages):
            if first is None and d.strip():
                first = asyncio.get_running_loop().time() - t0
            text += d
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"{type(e).__name__}: {e}"})
    total = asyncio.get_running_loop().time() - t0
    return JSONResponse({"ok": True, "text": text.strip(), "first_s": round(first or total, 2), "total_s": round(total, 2),
                         "model": llm_settings.llm_model})


# ---------- Spotify (관리자 '설정' 탭 → 음악, music.py / 말로 조작은 music_intent.py) ----------
# 앱 Secret · 토큰은 내보내지 않는다. 재생 화면(Web Playback SDK)에는 접근 토큰만 준다

def _music_fail(e: Exception) -> HTTPException:
    return HTTPException(400 if isinstance(e, MusicError) else 502, str(e) if isinstance(e, MusicError) else f"{type(e).__name__}: {e}")


def _public_base(request: Request) -> str:
    """밖에서 들어오는 주소. .env 의 RIBBON_PUBLIC_URL (Cloudflare Tunnel 도메인 등), 없으면 요청에 담긴 주소"""
    if settings.public_url:
        return settings.public_url.rstrip("/")
    return str(request.base_url).rstrip("/")


def _redirect_uri(request: Request) -> str:
    """Spotify 앱 설정의 Redirect URI 에 이 주소를 똑같이 넣는다.
    도메인(https)이 있으면 그 주소, 없으면 127.0.0.1 (Spotify 는 localhost 를 받지 않는다)"""
    if settings.public_url:
        return f"{_public_base(request)}/api/music/callback"
    return f"http://127.0.0.1:{request.url.port or 8765}/api/music/callback"


@app.get("/api/music/status")
async def api_music_status(request: Request):
    return JSONResponse({**spotify.status(), "redirect_uri": _redirect_uri(request),
                         "devices": sorted(music.devices), "last_error": music.last_error})


@app.put("/api/music/app")
async def api_music_app(data: dict = Body(...)):
    """Spotify 개발자 앱의 Client ID / Secret (Secret 을 비우면 예전 것을 그대로 쓴다)"""
    try:
        spotify.set_app(str(data.get("client_id") or ""), str(data.get("client_secret") or ""))
    except MusicError as e:
        raise HTTPException(400, str(e))
    return JSONResponse(spotify.status())


@app.get("/api/music/login")
async def api_music_login(request: Request):
    from fastapi.responses import RedirectResponse
    try:
        return RedirectResponse(spotify.login_url(_redirect_uri(request)))
    except MusicError as e:
        raise HTTPException(400, str(e))


def _page(title: str, text: str) -> Response:
    from html import escape
    return Response(f"""<!doctype html><meta charset="utf-8"><title>{escape(title)}</title>
<body style="font-family:system-ui,sans-serif;padding:40px;line-height:1.6"><h2>{escape(title)}</h2><p>{escape(text)}</p></body>""",
                    media_type="text/html; charset=utf-8")


@app.get("/api/music/callback")
async def api_music_callback(code: str = "", state: str = "", error: str = ""):
    if error:
        return _page("Spotify 연결 안 됨", f"Spotify 가 거절했습니다: {error}")
    try:
        account = await spotify.finish(code, state)
    except Exception as e:  # noqa: BLE001 - 화면에 이유를 보인다
        return _page("Spotify 연결 안 됨", str(e))
    await dialogue.notify_config_changed()
    return _page("Spotify 연결됨", f"{account.get('name')} 계정으로 연결했습니다. 이 창을 닫고 관리자 페이지로 돌아가세요.")


@app.post("/api/music/callback_url")
async def api_music_callback_url(data: dict = Body(...)):
    """다른 컴퓨터에서 로그인해 127.0.0.1 로 못 돌아온 경우: 그 창의 주소를 붙여 넣는다"""
    try:
        account = await spotify.finish_from_url(str(data.get("url") or ""))
    except Exception as e:  # noqa: BLE001
        raise _music_fail(e)
    await dialogue.notify_config_changed()
    return JSONResponse({"ok": True, "account": account})


@app.delete("/api/music/auth")
async def api_music_logout():
    spotify.disconnect()
    log.info("Spotify 연결 끊음")
    await dialogue.notify_config_changed()
    return JSONResponse({"ok": True})


@app.get("/api/music/playlists")
async def api_music_playlists():
    try:
        return JSONResponse({"playlists": await spotify.playlists()})
    except Exception as e:  # noqa: BLE001
        raise _music_fail(e)


@app.post("/api/music/playlists")
async def api_music_playlist_create(data: dict = Body(...)):
    """새 재생목록 만들기 (비공개). 만들면 리본이가 쓰는 '내 목록'으로 삼는다"""
    try:
        pl = await spotify.create_playlist(str(data.get("name") or ""))
    except Exception as e:  # noqa: BLE001
        raise _music_fail(e)
    store.update_music({"playlist_id": pl["id"], "playlist_title": pl["title"]})
    log.info("재생목록 만듦: %s", pl["title"])
    await dialogue.notify_config_changed()
    return JSONResponse({"ok": True, "playlist": pl})


@app.get("/api/music/playlist")
async def api_music_playlist(id: str = ""):
    """관리자 '목록' 탭: 그 목록의 곡들 (id 가 없으면 설정에서 고른 내 목록)"""
    try:
        pid = id or (await music.default_list())["id"]
        return JSONResponse({"id": pid, "tracks": await spotify.playlist_tracks(pid)})
    except Exception as e:  # noqa: BLE001
        raise _music_fail(e)


@app.post("/api/music/playlist/edit")
async def api_music_playlist_edit(data: dict = Body(...)):
    """목록 고치기: {action: add|remove|move, id, uri, from, to}. 목록을 보여 주던 화면도 새로 고친다"""
    action, pid = str(data.get("action") or ""), str(data.get("id") or "")
    try:
        if not pid:
            pid = (await music.default_list())["id"]
        if action == "add":
            await spotify.add(pid, [str(data["uri"])])
        elif action == "remove":
            await spotify.remove(pid, [str(data["uri"])])
        elif action == "move":
            await spotify.move(pid, int(data["from"]), int(data["to"]))
        else:
            raise HTTPException(400, f"모르는 동작입니다: {action}")
        tracks = await spotify.playlist_tracks(pid)
    except KeyError as e:
        raise HTTPException(400, f"값이 빠졌습니다: {e}")
    except Exception as e:  # noqa: BLE001
        raise _music_fail(e)
    if await music.refresh_list(pid, tracks):        # TV 에 번호 목록을 띄워 둔 중이면 같이 바뀐다
        await hub.broadcast({"type": "music.list", "view": music.list_view()})
    return JSONResponse({"id": pid, "tracks": tracks})


@app.get("/api/music/search")
async def api_music_search(q: str, limit: int = 10):
    """관리자 '목록' 탭의 노래 검색 (Spotify 개발 모드는 한 번에 10곡까지)"""
    try:
        return JSONResponse({"tracks": await spotify.search(q, limit)})
    except Exception as e:  # noqa: BLE001
        raise _music_fail(e)


@app.post("/api/music/play")
async def api_music_play(data: dict = Body(...)):
    """관리자 화면에서 눌러 듣기: {uri} 한 곡, 또는 {playlist_id} 목록 전체. 재생할 곳은 설정을 따른다"""
    try:
        if data.get("uri"):
            await spotify.play(music.device(), uris=[str(data["uri"])])
            music.source = {"kind": "search", "title": str(data.get("title") or "고른 노래")}
        else:
            pid = str(data.get("playlist_id") or "") or (await music.default_list())["id"]
            await spotify.play(music.device(), context_uri=f"spotify:playlist:{pid}")
            music.source = {"kind": "playlist", "title": str(data.get("title") or ""), "id": pid}
    except Exception as e:  # noqa: BLE001
        raise _music_fail(e)
    return JSONResponse({"ok": True})


@app.get("/api/music/devices")
async def api_music_devices():
    """Spotify 앱이 켜진 기기들 (폰 앱·사운드바…). 재생할 곳을 'Spotify 기기'로 두면 여기서 고른다"""
    try:
        return JSONResponse({"devices": await spotify.devices()})
    except Exception as e:  # noqa: BLE001
        raise _music_fail(e)


@app.post("/api/music/control")
async def api_music_control(data: dict = Body(...)):
    """관리자 페이지 위쪽 플레이어: {action: pause|resume|next|prev|repeat|shuffle, value}"""
    action, value = str(data.get("action") or ""), str(data.get("value") or "")
    try:
        dev = music.device()
        if action == "pause":
            await spotify.pause(dev)
        elif action == "resume":
            await spotify.resume(dev)
        elif action == "next":
            await spotify.next(dev)
        elif action == "prev":
            await spotify.previous(dev)
        elif action == "repeat":
            await spotify.repeat(dev, value if value in ("off", "context", "track") else "off")
        elif action == "shuffle":
            await spotify.shuffle(dev, value == "on")
        else:
            raise HTTPException(400, f"모르는 동작입니다: {action}")
    except Exception as e:  # noqa: BLE001
        raise _music_fail(e)
    return JSONResponse({"ok": True})


@app.get("/api/music/token")
async def api_music_token():
    """재생 화면(Web Playback SDK)이 쓰는 접근 토큰 (1시간짜리, 필요할 때마다 다시 받는다)"""
    if not store.config.music.enabled:
        raise HTTPException(400, "음악이 꺼져 있습니다")
    try:
        return JSONResponse({"access_token": await spotify.access_token()})
    except Exception as e:  # noqa: BLE001
        raise _music_fail(e)


@app.post("/api/music/command")
async def api_music_command(data: dict = Body(...)):
    """관리자 '음악' 설정의 시험 칸: 리본이에게 하듯 말을 넣어 본다 (리본이는 말하지 않는다)"""
    lines = await music.handle(str(data.get("text") or ""), dialogue.ribbon_name)
    return JSONResponse({"understood": lines is not None, "lines": lines or [], "error": music.last_error})


@app.put("/api/config/music")
async def api_config_music(data: dict = Body(...)):
    try:
        cfg = store.update_music(data)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    spotify.market = cfg.market
    log.info("음악 설정: 켜기=%s 재생할 곳=%s%s 목록=%s 음량=%s", cfg.enabled, cfg.output,
             f"({cfg.device_name})" if cfg.output == "spotify" else "",
             cfg.playlist_title or cfg.playlist_id or "(첫 목록)", cfg.volume)
    await dialogue.notify_config_changed()
    return JSONResponse(cfg.model_dump())


# ---------- 시간표 (대시보드). 정규 수업은 아이마다(KidInfo.schedule), 끌어 옮긴 건 그날만 ----------

def _date_param(s: str) -> "dt.date":
    try:
        return dt.date.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, f"날짜 형식이 잘못됐습니다: {s}")


@app.get("/api/schedule")
async def api_schedule(start: str, end: str):
    a, b = _date_param(start), _date_param(end)
    if b < a or (b - a).days > 62:
        raise HTTPException(400, "기간은 62일까지")
    items = schedule.occurrences(kids.all(), a, b, include_cancelled=True)
    return JSONResponse({"items": [o.model_dump() for o in items],
                         "day_start": sched.DAY_START, "day_end": sched.DAY_END})


def _schedule_kid(data: dict):
    kid = kids.get(str(data.get("kid_id") or ""))
    if kid is None:
        raise HTTPException(404, "없는 아이입니다")
    _date_param(str(data.get("orig_date") or ""))
    return kid, str(data["orig_date"]), str(data.get("orig_start") or "")


@app.post("/api/schedule/move")
async def api_schedule_move(data: dict = Body(...)):
    """수업 하나를 그날만 옮긴다 {kid_id, orig_date, orig_start, date, start}"""
    kid, od, os_ = _schedule_kid(data)
    date, start = str(data.get("date") or ""), str(data.get("start") or "")
    _date_param(date)
    if not sched.valid_time(start):
        raise HTTPException(400, f"시각 형식이 잘못됐습니다: {start}")
    try:
        ov = sched.move(schedule.overrides, kid, od, os_, date, start)
    except ValueError as e:
        raise HTTPException(400, str(e))
    schedule.save()
    return JSONResponse(ov.model_dump())


@app.post("/api/schedule/cancel")
async def api_schedule_cancel(data: dict = Body(...)):
    """그날 결석 {kid_id, orig_date, orig_start}"""
    kid, od, os_ = _schedule_kid(data)
    try:
        sched.cancel(schedule.overrides, kid, od, os_)
    except ValueError as e:
        raise HTTPException(400, str(e))
    schedule.save()
    return JSONResponse({"ok": True})


@app.post("/api/schedule/restore")
async def api_schedule_restore(data: dict = Body(...)):
    """옮기거나 결석한 수업을 원래대로"""
    kid, od, os_ = _schedule_kid(data)
    sched.restore(schedule.overrides, kid.id, od, os_)
    schedule.save()
    return JSONResponse({"ok": True})


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


@app.get("/api/world/view")
async def api_world_view(room: str | None = None):
    """TV 가 그리는 그대로의 값(배치 + 배경 렌더). 전시실 꾸미기(?mode=art)가 TV 와 같은 화면을 띄운다"""
    r = _room_param(room)
    return JSONResponse({"room": r, "layout": world.layout(r), "render": world.render_info(r)})


@app.put("/api/world/layout")
async def api_world_layout_put(room: str, data: dict = Body(...)):
    r = _room_param(room)
    try:
        world.save_layout(r, data)
    except (ValueError, TypeError, KeyError) as e:
        raise HTTPException(400, str(e))
    # 아이 전시실은 배경을 같이 쓰므로 다시 렌더하지 않는다 (그림은 TV 가 실시간으로 그린다)
    rendering = bool(settings.render_auto and not world.live_arts(r) and renderer.request(r))
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
async def api_kid_gallery(kid_id: str, hall: int = 1):
    """아이 전시실(hall 실): 걸린 그림이 든 배치 + 그 아이가 올린 그림 목록 + 벽 정보(카탈로그)"""
    if not kids.get(kid_id):
        raise HTTPException(404, "없는 아이입니다")
    hall = max(1, min(hall, world.halls(kid_id)))
    room = world.kid_room(kid_id, hall)
    return JSONResponse({"room": room, "hall": hall, "halls": world.halls(kid_id),
                         "kid": kids.get(kid_id).model_dump(), "layout": world.layout(room),
                         "artworks": world.artworks(kid_id), "catalog": world.catalog})


@app.put("/api/kids/{kid_id}/halls")
async def api_kid_halls(kid_id: str, data: dict = Body(...)):
    """전시실 수 바꾸기 {"count": 3}. 줄이면 뒤쪽 실에 걸어 둔 목록은 지워진다"""
    if not kids.get(kid_id):
        raise HTTPException(404, "없는 아이입니다")
    try:
        count = world.set_halls(kid_id, int(data.get("count", 1)))
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    await dialogue.notify_config_changed()
    return JSONResponse({"ok": True, "halls": count})


@app.delete("/api/kids/{kid_id}/halls/{hall}")
async def api_kid_hall_delete(kid_id: str, hall: int):
    """고른 전시실 하나 없애기 (뒤 실들이 한 칸씩 당겨진다). 그 방에 걸어 둔 그림은 내려진다"""
    if not kids.get(kid_id):
        raise HTTPException(404, "없는 아이입니다")
    try:
        left = world.remove_hall(kid_id, hall)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    await dialogue.notify_config_changed()
    return JSONResponse({"ok": True, "halls": left})


@app.get("/api/kids/{kid_id}/export")
async def api_kid_export(kid_id: str):
    """전시실을 .html 한 장으로 (서버 없이 폰에서 열린다). 전시실 꾸미기 → 공유 → 내보내기"""
    kid = kids.get(kid_id)
    if not kid:
        raise HTTPException(404, "없는 아이입니다")
    viewer = settings.client_dist_path().parent / "dist-export" / "viewer.js"
    if not viewer.is_file():
        raise HTTPException(500, "내보내기 화면이 없습니다. client 에서 npm run build 를 다시 하세요")
    name, html = await asyncio.to_thread(gallery_export.build, world, kid, viewer.read_text(encoding="utf-8"),
                                         renderer.dir)
    log.info("전시실 내보내기: %s (%.1fMB)", kid.name, len(html.encode()) / 1024 / 1024)
    return Response(html, media_type="text/html; charset=utf-8", headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}",
    })


@app.get("/api/kids/{kid_id}/share")
async def api_kid_share(kid_id: str, request: Request):
    """부모님께 보낼 전시실 주소 (로그인 없이 보기만 된다, /?mode=gallery&k=열쇠)"""
    if not kids.get(kid_id):
        raise HTTPException(404, "없는 아이입니다")
    token = world.share_token(kid_id)
    return JSONResponse({"token": token, "url": f"{_public_base(request)}/?mode=gallery&k={token}"})


@app.get("/api/share/{token}")
async def api_share(token: str):
    """공유 주소로 들어온 사람에게: 아이 이름과 전시실들 (보기 전용. 로그인 없이 열린다, auth.permitted)"""
    kid_id = world.shared_kid(token)
    kid = kids.get(kid_id) if kid_id else None
    if not kid:
        raise HTTPException(404, "없는 주소입니다")
    halls = [{"room": r, "layout": world.layout(r), "render": world.render_info(r)} for r in world.kid_rooms(kid.id)]
    hung = {a.get("image") for h in halls for a in (h["layout"] or {}).get("arts", [])}
    return JSONResponse({"name": kid.name, "halls": halls,
                         "artworks": [a for a in world.artworks(kid.id) if a["file"] in hung]})


@app.post("/api/world/visit")
async def api_world_visit(data: dict = Body(...)):
    """TV 가 잠깐 아이 전시실을 보러 간다. seconds 뒤에 원래 방(보통 교실)으로 돌아온다.
    seconds 가 0 이면 돌아오지 않는다 (계속 그 방)."""
    kid_id = str(data.get("kid_id") or "")
    room = world.kid_room(kid_id, int(data.get("hall") or 1)) if kid_id else str(data.get("room") or "")
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


@app.put("/api/artworks/meta")
async def api_artwork_meta(data: dict = Body(...)):
    """작품의 모습·적어 둔 것 바꾸기 {"file", "bg", "pad", "frame", "name", "made", "note"}. 걸려 있는 곳도 같이 바뀐다"""
    try:
        entry, rooms = world.update_artwork(str(data.get("file", "")), data)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    if world.active in rooms:
        await dialogue.notify_config_changed()
    return JSONResponse({"ok": True, "artwork": entry, "rooms": rooms})


@app.post("/api/artworks/replace")
async def api_artwork_replace(data: dict = Body(...)):
    """편집해서 새로 올린 그림으로 갈아 끼우기 {"old", "new"}: 걸린 곳을 모두 새 그림으로 바꾸고 옛 파일을 지운다"""
    try:
        rooms = world.replace_artwork(str(data.get("old", "")), str(data.get("new", "")))
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    if world.active in rooms:
        await dialogue.notify_config_changed()
    return JSONResponse({"ok": True, "rooms": rooms})


@app.post("/api/artworks/delete")
async def api_artwork_delete(data: dict = Body(...)):
    try:
        world.delete_artwork(str(data.get("file", "")))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return JSONResponse({"ok": True})


@app.post("/api/cutout")
async def api_cutout(data: dict = Body(...)):
    """작품 사진에서 작품만 골라낸 마스크 (ribbon/cutout.py). 모델이 아직 없으면 받기 시작하고 202 를 준다"""
    st = cutout.status()
    if st["state"] == "unavailable":
        raise HTTPException(501, st["detail"])
    if st["state"] != "ready":
        cutout.start_download()
        return JSONResponse({**cutout.status(), "ok": False}, status_code=202)
    raw = str(data.get("data") or "")
    if ";base64," not in raw:
        raise HTTPException(400, "이미지 데이터 형식이 아닙니다")
    try:
        png = await asyncio.to_thread(cutout.mask_png, base64.b64decode(raw.split(";base64,", 1)[1]))
    except (CutoutError, ValueError) as e:
        raise HTTPException(400, str(e))
    return JSONResponse({"ok": True, "mask": "data:image/png;base64," + base64.b64encode(png).decode()})


@app.get("/api/tts/voices")
async def api_tts_voices():
    """관리자 캐릭터 탭의 목소리 고르기 칸 (기본 10개 + 섞은 조합, ribbon/voices.py)"""
    return JSONResponse({"voices": list_voices(), "custom": hasattr(tts, "configure")})


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


_barge: Dict[int, BargeIn] = {}      # 채널별 끼어들기 감지 (audio/bargein.py)


async def _transcribe_and_dispatch(channel: int, pcm: np.ndarray) -> None:
    prompt = dialogue.stt_prompt()           # 아이·캐릭터 이름, 게임 말을 미리 알려 준다
    try:
        text = await stt.transcribe(pcm, settings.sample_rate, prompt)
    except Exception:
        log.exception("STT 실패 (ch=%s, %.1fs)", channel, len(pcm) / settings.sample_rate)
        return
    if store.config.ribbon.save_recordings:  # 인식 개선용 (tools/stt_eval.py)
        kid = kids.by_channel(channel)
        recorder.save(settings.settings_path().parent / "recordings", pcm, settings.sample_rate, channel, text,
                      prompt, kid.id if kid else None)
    if text and not _heard_elsewhere(channel, text):
        await dialogue.on_utterance(channel, text)


_recent_text: Dict[str, tuple] = {}   # 들은 말 -> (채널, 시각)


def _heard_elsewhere(channel: int, text: str, window_s: float = 2.5) -> bool:
    """같은 말이 거의 같은 때 다른 채널에서도 들렸으면 한 소리(스피커·방 소리)가 여러 마이크로 들어간 것.
    아이 둘이 똑같은 말을 동시에 할 일은 드물어서 뒤에 온 것은 버린다"""
    key = "".join(ch for ch in text if ch.isalnum())
    now = asyncio.get_running_loop().time()
    prev = _recent_text.get(key)
    _recent_text[key] = (channel, now)
    for k, (_, at) in list(_recent_text.items()):
        if now - at > window_s:
            del _recent_text[k]
    if prev and prev[0] != channel and now - prev[1] < window_s:
        log.info("다른 채널(%d)에서 방금 들은 말이라 버림: ch=%d %s", prev[0], channel, text)
        return True
    return False


_audio_seen: Dict[int, float] = {}


async def _handle_audio(channel: int, pcm: np.ndarray) -> None:
    now = asyncio.get_running_loop().time()
    if now - _audio_seen.get(channel, -1e9) > 60:
        log.info("마이크 소리 들어옴: 채널 %d", channel)   # 처음, 또는 1분 넘게 끊겼다가 다시 들어올 때
    _audio_seen[channel] = now
    proc = processors.get(channel)
    if proc is None:
        return
    proc.set_silence_ms(store.config.ribbon.end_silence_ms)   # 관리자 화면에서 바꾸면 바로
    proc.follow_up_s = 20.0 if (dialogue.quiz and dialogue.quiz.active) else None   # 게임 중엔 답할 시간을 넉넉히
    button_only = store.config.ribbon.input_mode == "button"   # 버튼을 누른 뒤 말 한 번만 받는다
    proc.single_shot = button_only
    proc.voice_wake = not button_only
    barge = _barge.setdefault(channel, BargeIn())
    if settings.echo_guard and dialogue.speaking():
        rc = store.config.ribbon
        if rc.barge_in and not button_only and kids.by_channel(channel) is not None:
            frames = barge.feed(pcm, rc.barge_in_rms)
            if frames is not None:
                # 아이가 끼어들었다: 리본이를 멈추고, 기억해 둔 0.5초(말 앞부분)부터 이어서 듣는다
                dialogue.note_barge_in()
                proc.start_listening()
                for f in frames:
                    proc.feed(f)
                _spawn(dialogue.barge_in(channel))
                return
        proc.hold()                  # 리본이 목소리가 마이크로 다시 들어오는 것 (에코)
        _update_mic()
        return
    if barge.peak:
        peak = barge.end()           # 리본이가 한 번 말하는 동안 이 마이크에 들어온 가장 큰 소리 = 에코 크기
        log.info("리본이 목소리가 마이크 %d 에 들어온 크기: %.3f (끼어들기 기준 %.3f)", channel + 1, peak,
                 store.config.ribbon.barge_in_rms)
    for kind, payload in proc.feed(pcm):
        if kind == "wake":
            if kids.by_channel(channel) is None and any(k.mic_channel is not None for k in kids.all()):
                proc.stop_listening()        # 아이가 없는 채널의 잡음으로 깨어나지 않는다 (예: 안 쓰는 4번)
                continue
            _spawn(dialogue.on_wake(channel, by_voice=True))   # 깨운 말을 그대로 받는다 (리본아 없이)
        elif kind == "utterance" and payload is not None:
            _spawn(_transcribe_and_dispatch(channel, payload))
    won = button_call.check(channel)
    if won is not None:
        _spawn(dialogue.claim(won))
    _update_mic()


_mic_on = False
_last_tv_call = 0.0      # TV 화면 호출을 연달아 누르는 것 막기


def _update_mic() -> None:
    """말을 받을 수 있는 동안(아이가 등록된 채널이 듣는 중이고 리본이가 말하지 않을 때)만 TV 오른쪽 위에 마이크 표시"""
    global _mic_on
    chans = {k.mic_channel for k in kids.all() if k.mic_channel is not None} or set(processors)
    on = not dialogue.speaking() and any(processors[c].state == "listening" for c in chans if c in processors)
    if on != _mic_on:
        _mic_on = on
        _spawn(hub.broadcast({"type": "mic", "on": on}))


def _kid_channels() -> List[int]:
    return sorted({k.mic_channel for k in kids.all() if k.mic_channel is not None}) or list(processors)


def _listening() -> bool:
    """지금 아이 말을 받는 중인가 (버튼을 누른 뒤 마이크가 열려 있는 상태)"""
    return any(processors[c].state == "listening" for c in _kid_channels() if c in processors)


async def _on_button() -> None:
    """호출 버튼 (DJI 송신기 · TV 화면 스위치 · /api/call). 지금 무엇을 하고 있었냐에 따라 다르게 (2026-09-21):
      - 리본이가 말하는 중  -> 말을 멈추고 "이어서 말할까? 새로 말할래?" 묻고 대답을 듣는다
      - 아이 말을 듣는 중   -> 이번 입력을 취소한다 (한 번 더 눌렀다 = 그만)
      - 그 밖              -> 하던 것을 멈추고 새로 듣는다 (먼저 말한 아이가 부른 아이, audio/button.py)"""
    if dialogue.ignore_calls:
        log.info("호출 무시 중이라 버튼을 받지 않음")
        return
    channels = _kid_channels()
    if dialogue.talking():
        await dialogue.pause_for_button()
        for proc in processors.values():
            proc.stop_listening()
        armed = button_call.press(channels, store.config.ribbon.button_window_s)
        log.info("호출 버튼(말하는 중): 멈추고 마이크 %s 듣는 중", [c + 1 for c in armed])
        return
    if _listening():
        for proc in processors.values():
            proc.stop_listening()
        button_call.cancel()
        await dialogue.cancel_listening()
        return
    await dialogue.reset_for_button()          # 하던 대화를 멈추고 처음부터 듣는다
    for proc in processors.values():
        proc.stop_listening()                    # 이어 말하기로 듣던 채널도 버튼 기준으로 새로
    await dialogue.on_button(channels)
    armed = button_call.press(channels, store.config.ribbon.button_window_s)   # 바로 듣는다 (TV 에 마이크 표시)
    log.info("호출 버튼: 마이크 %s 듣는 중", [c + 1 for c in armed])


async def _handle_text(ws: WebSocket, msg: dict) -> None:
    t = msg.get("type")
    if t == "hello":
        hub.clients[ws] = msg.get("role", "unknown")
        hub.ids[ws] = str(msg.get("client_id") or "")
        if hub.clients[ws] == "admin":
            await ws.send_text(json.dumps(devices.snapshot(), ensure_ascii=False))
        await ws.send_text(json.dumps(dialogue.snapshot().model_dump(), ensure_ascii=False))
        await ws.send_text(json.dumps({"type": "mic", "on": _mic_on}))   # 마이크 표시
        if music.state:                              # 음악 상태바
            await ws.send_text(json.dumps(music.state, ensure_ascii=False))
        if music.listing:                            # 보여 주던 번호 목록 (TV 를 새로 열어도)
            await ws.send_text(json.dumps({"type": "music.list", "view": music.list_view()}, ensure_ascii=False))
        if dialogue.quiz and dialogue.quiz.active:   # TV 를 새로 열어도 하던 게임 화면이 나오게
            await ws.send_text(json.dumps({"type": "game", "view": dialogue.quiz.view()}, ensure_ascii=False))
    elif t == "tts.done":
        dialogue.mark_spoken(msg.get("utterance_id", ""))
    elif t == "tv.call":
        # TV 화면(폰 등)의 "리본아" 단추·엔터키. 호출 버튼을 누른 것과 같게 다룬다.
        # 폰에 DJI 수신기를 꽂으면 버튼이 그냥 폰 볼륨만 올린다 (웹페이지가 USB 장치를 잡을 수 없다)
        global _last_tv_call
        now = asyncio.get_running_loop().time()
        if now - _last_tv_call < 1.5:
            return                                   # 연달아 누른 것은 한 번으로
        _last_tv_call = now
        log.info("TV 화면에서 호출")
        _spawn(_on_button())
    elif t == "debug.wake":
        ch = int(msg.get("channel", 0))
        processors[ch].start_listening()
        _spawn(dialogue.on_wake(ch))
    elif t == "client.log":
        log.warning("[%s %s] %s", hub.clients.get(ws, "?"), ws.client.host if ws.client else "?",
                    str(msg.get("text", ""))[:300])
    elif t == "debug.utterance":
        _spawn(dialogue.on_utterance(int(msg.get("channel", 0)), str(msg.get("text", ""))))
    elif t == "device.status":
        # TV 가 알려 온 소리 출력 장치 상태 → 관리자 '설정' 탭
        if devices.update(hub.agent(ws), str(msg.get("kind") or ""), hub.clients.get(ws, "?"),
                          ws.client.host if ws.client else "?", msg):
            await hub.broadcast(devices.snapshot(), roles={"admin"})
    elif t == "devices.get":
        await ws.send_text(json.dumps(devices.snapshot(), ensure_ascii=False))   # 관리자 '설정' 탭을 열 때
    elif t == "device.control":
        # 관리자가 고른 장치 설정 → 그 화면으로
        sent = await hub.send_to(str(msg.get("agent") or ""), msg)
        if not sent:
            await ws.send_text(json.dumps({"type": "admin.msg", "error": True,
                                           "text": "그 화면이 연결되어 있지 않습니다 (창이 닫혔거나 새로 열리는 중)"},
                                          ensure_ascii=False))
    elif t == "admin.wake":
        # 관리자가 누른 호출: 아이(kid_id)의 마이크 채널로, 호출 무시 중에도 받는다
        kid = kids.get(str(msg.get("kid_id") or ""))
        ch = kid.mic_channel if kid else msg.get("channel")
        if ch is None or int(ch) not in processors:
            await ws.send_text(json.dumps({"type": "admin.msg", "error": True,
                                           "text": f"{kid.name if kid else '아이'}에게 마이크가 지정되지 않았습니다"},
                                          ensure_ascii=False))
            return
        processors[int(ch)].start_listening()
        _spawn(dialogue.on_wake(int(ch), force=True))
    elif t == "admin.stop":
        if msg.get("all"):
            for p in processors.values():
                p.stop_listening()
        _spawn(dialogue.stop(clear_queue=bool(msg.get("all"))))
    elif t == "admin.game":
        # 관리자 대시보드의 포켓몬 맞추기 버튼
        if msg.get("action") == "stop":
            _spawn(dialogue.stop_quiz())
        else:
            _spawn(dialogue.start_quiz(str(msg.get("mode") or ""), confirm=False))
    elif t == "admin.ignore":
        on = bool(msg.get("on"))
        if on:
            for p in processors.values():
                p.stop_listening()
        _spawn(dialogue.set_ignore_calls(on))
    elif t == "kid.enter":
        _spawn(dialogue.on_kid_enter(str(msg.get("kid_id", ""))))
    elif t == "kid.leave":
        _spawn(dialogue.on_kid_leave(str(msg.get("kid_id", ""))))
    elif t == "music.device":
        # 재생 화면(Web Playback SDK)이 Spotify 스피커로 준비됐다 / 닫혔다
        role = hub.clients.get(ws, "?")
        music.set_device(role, str(msg.get("device_id") or ""))
        log.info("Spotify 스피커 %s: %s", "준비" if msg.get("device_id") else "닫힘", role)
    elif t == "music.state":
        # 재생 화면이 알려 온 재생 상태 -> TV 아래 상태바. 지금 '재생할 곳' 화면의 것만 받는다
        if hub.clients.get(ws) == store.config.music.output:
            state = {"type": "music.state", "playing": bool(msg.get("playing")), "track": msg.get("track"),
                     "position_ms": int(msg.get("position_ms") or 0),
                     # 상태바 표시: 반복·섞기와 무엇을 틀고 있나 (검색한 한 곡 / 재생목록 이름)
                     "repeat": str(msg.get("repeat") or "off"), "shuffle": bool(msg.get("shuffle")),
                     "source": music.source_info(str(msg.get("context_uri") or ""))}
            music.set_state(state)
            await hub.broadcast(state)
    elif t == "face.positions":
        # TV 위 카메라 클라이언트 -> TV 화면(시선 추적)으로 그대로 중계
        await hub.broadcast(msg, roles={"tv"})
    else:
        log.debug("unknown message: %s", t)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    if not auth.empty and auth.user_for(ws.cookies.get(auth_mod.COOKIE)) is None:
        await ws.close(code=4401)          # 로그인하지 않았다 (화면이 로그인 창을 띄운다)
        return
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
        aid = hub.agent(ws)
        role = hub.clients.get(ws)
        hub.clients.pop(ws, None)
        if role in music.devices and role not in hub.clients.values():
            music.set_device(role, "")                  # 재생 화면이 모두 닫혔다
            if role == store.config.music.output and music.state:
                music.set_state({"type": "music.state", "playing": False, "track": None, "position_ms": 0})
                await hub.broadcast(music.state)        # 상태바 내리기
        hub.ids.pop(ws, None)
        if not any(hub.agent(w) == aid for w in hub.ids) and devices.drop_agent(aid):
            await hub.broadcast(devices.snapshot(), roles={"admin"})   # 그 화면이 닫혔다


art_dir = settings.artworks_path()
art_dir.mkdir(parents=True, exist_ok=True)
app.mount("/artworks", StaticFiles(directory=str(art_dir)), name="artworks")  # 배치의 image = "artworks/<파일>"
render_dir = renderer.dir
render_dir.mkdir(parents=True, exist_ok=True)
app.mount("/world-render", StaticFiles(directory=str(render_dir)), name="world-render")   # TV 배경 렌더

# TV 웹캠의 MediaPipe wasm: 맥 파이썬이 .wasm 형식을 모르면 브라우저가 느린 길로 읽는다
mimetypes.add_type("application/wasm", ".wasm")
dist = settings.client_dist_path()
if dist.exists():
    app.mount("/", StaticFiles(directory=str(dist), html=True), name="client")
