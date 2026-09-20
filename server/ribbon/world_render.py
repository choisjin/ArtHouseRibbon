"""TV 배경 렌더 작업 (블렌더 헤드리스).

편집기에서 배치를 저장하면 그 방을 다시 렌더한다. 한 번에 하나씩, 렌더 중에 또 저장하면 끝난 뒤 한 번 더.
방 하나를 시간대(일출·아침·낮·일몰·밤, tools/blender/phases.py)마다 한 장씩 렌더하고,
TV 가 시계를 보고 그중 하나를 고른다. 창이 없는 전시장은 한 장뿐이다.
결과는 data/world/render/ 에
  <방>_<시간대>.png       TV 배경
  <방>_<시간대>_env.hdr   리본이 조명용 360° 환경
  <방>_<시간대>_pano.jpg  전시실 둘러보기용 360° 파노라마 (전시장 껍데기를 쓰는 방만)
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
                                        # 방 모양 이름(shell)으로 본다: 아이 전시실·kidbase 는 gallery 껍데기


#: 방 모양(shell)별 렌더 방식 판. 올리면 그 껍데기를 쓰는 방은 켜질 때 다시 렌더한다
#: gallery 2: 천장 레일 조명을 빼고, 둘러보기 파노라마를 같이 굽는다
#: gallery 3: 파노라마에만 앞벽을 세운다 (열린 앞면으로 바깥이 보이지 않게)
SHELL_VERSION = {"gallery": 3}
PANO_SHELLS = {"gallery"}
HIDE_PARTS = {"gallery": "CeilingTrack,CeilingSpot"}
PANO_EYE_M = 1.9                        # 파노라마를 찍는 눈높이 (m). 벽(4.6m)이 위아래로 고루 보이게 사람 눈보다 조금 높다
PANO_BACK = 0.18                        # 방 가운데에서 열린 앞쪽으로 물러서는 정도 (방 깊이의 비율): 정면 벽이 한눈에 들어오게


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
        """렌더가 있으면 TV 가 쓸 주소(시간대별)와 그때의 배치.
        아이 전시실은 그림을 뺀 공용 배경(kidbase)을 쓰고, 걸린 그림은 TV 가 실시간으로 그린다."""
        if self.world.live_arts(room):           # 전시장·아이 전시실: 빈 전시실 배경을 같이 쓴다
            shared = self.info("kidbase")
            if not shared:
                return None
            return {**shared, "layout": self.world.layout(room), "arts_live": True, "stale": False}
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
            pano = self.dir / f"{room}_{name}_pano.jpg"
            got[name] = {
                "bg": f"/world-render/{png.name}?v={v}",
                "env": f"/world-render/{hdr.name}?v={v}" if hdr.exists() else None,
                "pano": f"/world-render/{pano.name}?v={v}" if pano.exists() and meta.get("pano_pos") else None,
            }
        if not got:
            return None
        now = phases.phase_of(time.localtime().tm_hour)
        cur = got.get(now) or next(iter(got.values()))
        return {
            "bg": cur["bg"],
            "env": cur["env"],
            "pano": cur["pano"],
            "pano_pos": meta.get("pano_pos"),          # 파노라마를 찍은 자리 (블렌더 좌표 x, y, z)
            "phases": got,
            # TV 가 제 시계로 고르도록 [시작 시각, 이름] 목록도 같이 준다
            "schedule": [[h, n] for h, n in phases.schedule() if n in got],
            "layout": meta.get("layout"),
            "rendered_at": v,
            "stale": (meta.get("layout") != self.world.layout(room)
                      or int(meta.get("version", 1)) != SHELL_VERSION.get(self.world.shell_room(room), 1)
                      or meta.get("pano_pos") != self.pano_pos(self.world.shell_room(room))),
        }

    def pano_pos(self, shell: str) -> Optional[List[float]]:
        """둘러보기 파노라마를 찍을 자리: 방 가운데에서 조금 물러선 곳 (블렌더 좌표). 파노라마를 굽지 않는 방이면 None"""
        info = (self.world.catalog.get("rooms") or {}).get(shell)
        if shell not in PANO_SHELLS or not info or "front_y" not in info or "back_y" not in info:
            return None
        front, back = float(info["front_y"]), float(info["back_y"])
        return [0.0, round((front + back) / 2 - PANO_BACK * abs(back - front), 4),
                round(PANO_EYE_M * float(info.get("unit_per_m", 1.0)), 4)]

    def status(self) -> Dict[str, Any]:
        rooms: Dict[str, Any] = {}
        for r in self.world.render_rooms():
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
        if self.world.live_arts(room):           # 그림만 거는 방은 따로 굽지 않는다: 같이 쓰는 빈 전시실 배경을
            room = "kidbase"
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
        shell = self.world.shell_room(room)
        want = room_phases(shell)
        cmd = [self.blender, "-b", "--factory-startup", "-P", str(SCRIPT), "--",
               room, str(lay_file), str(self.world.art_dir.parent), str(work), *want]
        env = dict(os.environ, PYTHONUNBUFFERED="1", RENDER_PCT=str(self.pct), RENDER_SAMPLES=str(self.samples),
                   RENDER_SHELL_ROOM=shell, RENDER_HIDE=HIDE_PARTS.get(shell, ""))
        pano_pos = self.pano_pos(shell)
        if pano_pos:
            env["RENDER_PANO"] = ",".join(str(v) for v in pano_pos)
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
            for tail in ("_env.hdr", "_pano.jpg"):
                extra = work / f"{room}_{p}{tail}"
                if extra.exists():
                    os.replace(extra, self.dir / f"{room}_{p}{tail}")
        _write_json(self.dir / f"{room}.json",
                    {"room": room, "layout": layout, "rendered_at": int(time.time()), "phases": done,
                     "version": SHELL_VERSION.get(shell, 1), "pano_pos": pano_pos})
        shutil.rmtree(work, ignore_errors=True)
        log.info("배경 렌더 완료: %s (%d초)", room, time.time() - self.started)
        return True
