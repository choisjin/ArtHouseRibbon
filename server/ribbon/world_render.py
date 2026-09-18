"""TV 배경 렌더 작업 (블렌더 헤드리스).

편집기에서 배치를 저장하면 그 방을 다시 렌더한다. 한 번에 하나씩, 렌더 중에 또 저장하면 끝난 뒤 한 번 더.
방 하나를 시간대(일출·아침·낮·일몰·밤, tools/blender/phases.py)마다 한 장씩 렌더하고,
TV 가 시계를 보고 그중 하나를 고른다. 창이 없는 전시장은 한 장뿐이다.
결과는 data/world/render/ 에
  <방>_<시간대>.png       TV 배경
  <방>_<시간대>_env.hdr   리본이 조명용 360° 환경
  <방>.json               렌더에 쓴 배치(TV 가 가림막·길찾기에 같은 배치를 쓴다) + 시각 + 시간대 목록
렌더 스크립트는 tools/blender/render_room.py.
"""
from __future__ import annotations

import asyncio
import glob
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .world_store import WorldStore, _read_json, _write_json

log = logging.getLogger("ribbon.render")
REPO = Path(__file__).resolve().parents[2]
BLENDER_DIR = REPO / "tools" / "blender"
SCRIPT = BLENDER_DIR / "render_room.py"
sys.path.insert(0, str(BLENDER_DIR))
import phases  # noqa: E402  (블렌더 없이도 읽히는 시간대 표. room_map.py 와 같은 파일을 본다)

DAYLIGHT_ROOMS = {"classroom"}          # 창이 있어 시간대별로 렌더하는 방 (room_map.ROOMS 의 daylight 와 같게)


def room_phases(room: str) -> List[str]:
    return list(phases.ORDER) if room in DAYLIGHT_ROOMS else [phases.DEFAULT]


def find_blender(configured: str = "") -> Optional[str]:
    cands: List[str] = []
    if configured:
        cands.append(configured)
    which = shutil.which("blender")
    if which:
        cands.append(which)
    if sys.platform == "darwin":
        cands += ["/Applications/Blender.app/Contents/MacOS/Blender",
                  os.path.expanduser("~/Applications/Blender.app/Contents/MacOS/Blender")]
    elif os.name == "nt":
        cands += sorted(glob.glob("C:/Program Files/Blender Foundation/Blender */blender.exe"), reverse=True)
    for c in cands:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


class WorldRenderer:
    def __init__(self, world: WorldStore, blender: str = "", pct: int = 50, samples: int = 96,
                 on_change: Optional[Callable[[], Awaitable[None]]] = None):
        self.world = world
        self.blender = find_blender(blender)
        self.pct = pct
        self.samples = samples
        self.on_change = on_change
        self.dir = world.dir / "render"
        self.log_path = self.dir / "render.log"
        self.running: Optional[str] = None
        self.started = 0.0
        self.pending: List[str] = []
        self.last: Dict[str, Any] = {}
        self._task: Optional[asyncio.Task] = None

    @property
    def available(self) -> bool:
        return self.blender is not None and SCRIPT.exists()

    # ---------- 조회 ----------
    def info(self, room: str) -> Optional[Dict[str, Any]]:
        """렌더가 있으면 TV 가 쓸 주소(시간대별)와 그때의 배치"""
        meta = _read_json(self.dir / f"{room}.json")
        if not meta:
            return None
        v = int(meta.get("rendered_at", 0))
        got: Dict[str, Any] = {}
        for name in meta.get("phases") or room_phases(room):
            png = self.dir / f"{room}_{name}.png"
            if not png.exists():
                continue
            hdr = self.dir / f"{room}_{name}_env.hdr"
            got[name] = {
                "bg": f"/world-render/{png.name}?v={v}",
                "env": f"/world-render/{hdr.name}?v={v}" if hdr.exists() else None,
            }
        if not got:
            return None
        now = phases.phase_of(time.localtime().tm_hour)
        cur = got.get(now) or next(iter(got.values()))
        return {
            "bg": cur["bg"],
            "env": cur["env"],
            "phases": got,
            # TV 가 제 시계로 고르도록 [시작 시각, 이름] 목록도 같이 준다
            "schedule": [[h, n] for h, n in phases.schedule() if n in got],
            "layout": meta.get("layout"),
            "rendered_at": v,
            "stale": meta.get("layout") != self.world.layout(room),
        }

    def status(self) -> Dict[str, Any]:
        rooms: Dict[str, Any] = {}
        for r in self.world.rooms():
            i = self.info(r)
            rooms[r] = {"rendered_at": i["rendered_at"], "stale": i["stale"]} if i else None
        return {
            "available": self.available,
            "blender": self.blender,
            "running": self.running,
            "elapsed": round(time.time() - self.started) if self.running else 0,
            "pending": list(self.pending),
            "last": self.last,
            "rooms": rooms,
        }

    def log_tail(self, n: int = 30) -> List[str]:
        try:
            lines = self.log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return []
        return [ln for ln in lines if "Deprecat" not in ln and "use_nodes" not in ln][-n:]

    # ---------- 실행 ----------
    def request(self, room: str) -> bool:
        """렌더 요청. 블렌더가 없으면 False"""
        if not self.available:
            return False
        self.world.check_room(room)
        if room not in self.pending:           # 그 방을 렌더 중이면 끝난 뒤 한 번 더
            self.pending.append(room)
        if not self._task or self._task.done():
            self._task = asyncio.create_task(self._loop())
        return True

    async def _notify(self) -> None:
        if self.on_change:
            try:
                await self.on_change()
            except Exception:  # noqa: BLE001
                log.exception("렌더 알림 실패")

    async def _loop(self) -> None:
        while self.pending:
            room = self.pending.pop(0)
            self.running, self.started = room, time.time()
            await self._notify()
            ok = False
            try:
                ok = await self._render(room)
            except Exception:  # noqa: BLE001
                log.exception("렌더 실패: %s", room)
            self.last = {"room": room, "ok": ok, "seconds": round(time.time() - self.started),
                         "finished": int(time.time())}
            self.running = None
            await self._notify()

    async def _render(self, room: str) -> bool:
        layout = self.world.layout(room)
        if layout is None:
            return False
        work = self.dir / f".work_{room}"
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True, exist_ok=True)
        lay_file = work / "layout.json"
        _write_json(lay_file, layout)
        want = room_phases(room)
        cmd = [self.blender, "-b", "--factory-startup", "-P", str(SCRIPT), "--",
               room, str(lay_file), str(self.world.art_dir.parent), str(work), *want]
        env = dict(os.environ, PYTHONUNBUFFERED="1", RENDER_PCT=str(self.pct), RENDER_SAMPLES=str(self.samples))
        log.info("배경 렌더 시작: %s (%s%%, %s samples, 시간대 %s)", room, self.pct, self.samples, ", ".join(want))
        self.dir.mkdir(parents=True, exist_ok=True)

        def run() -> int:   # Windows 기본 이벤트 루프는 비동기 하위 프로세스를 못 써서 스레드에서 돌린다
            with open(self.log_path, "w", encoding="utf-8", errors="replace") as out:
                return subprocess.run(cmd, stdout=out, stderr=subprocess.STDOUT, cwd=str(REPO), env=env).returncode

        job = asyncio.create_task(asyncio.to_thread(run))
        while not job.done():   # 블렌더 출력은 render.log 로 가므로 서버 창에는 30초마다 진행 상황만
            await asyncio.wait({job}, timeout=30)
            if not job.done():
                tail = self.log_tail(1)
                log.info("배경 렌더 중: %s %d초 | %s", room, time.time() - self.started, tail[0][:120] if tail else "")
        rc = job.result()
        done = [p for p in want if (work / f"{room}_{p}.png").exists()]
        if rc != 0 or not done:
            log.warning("배경 렌더 실패: %s (종료 코드 %s) → %s", room, rc, self.log_path)
            return False
        for p in done:                       # 시간대별 배경 + 환경 HDR 을 한꺼번에 바꿔 넣는다
            os.replace(work / f"{room}_{p}.png", self.dir / f"{room}_{p}.png")
            hdr = work / f"{room}_{p}_env.hdr"
            if hdr.exists():
                os.replace(hdr, self.dir / f"{room}_{p}_env.hdr")
        _write_json(self.dir / f"{room}.json",
                    {"room": room, "layout": layout, "rendered_at": int(time.time()), "phases": done})
        shutil.rmtree(work, ignore_errors=True)
        log.info("배경 렌더 완료: %s (%d초)", room, time.time() - self.started)
        return True
