"""3D 맵(방 + 가구 배치 + 걸린 그림) 저장소.

모델과 카탈로그는 Character_Creator(블렌더)에서 만든 것을 client/public/world/ 에 둔다 (tools/sync_world.py).
배치는 방마다 data/world/<room>.json 이고, 형식은 Character_Creator 의 layout.json 과 같다.
  - 파일이 없으면 catalog.json 의 기본 배치를 쓴다.
  - 저장할 때마다 이전 파일은 data/world/history/ 에 보관한다.
  - TV 에 보여줄 방은 data/world/world.json 의 active.
그림 파일은 data/artworks/ (index.json 이 목록), 배치의 image 는 "artworks/<파일>" 로 적는다.
"""
from __future__ import annotations

import base64
import datetime
import hashlib
import json
import logging
import os
import shutil
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

log = logging.getLogger("ribbon.world")

ART_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
MAX_UPLOAD = 60 * 1024 * 1024
HISTORY_KEEP = 50


def _read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


class WorldStore:
    def __init__(self, catalog_path: Path, data_dir: Path, art_dir: Path):
        self.catalog_path = catalog_path
        self.dir = data_dir
        self.art_dir = art_dir
        self._lock = threading.Lock()
        self._catalog: Optional[Dict[str, Any]] = None
        self._catalog_mtime = 0.0
        # 배경 렌더 정보 (world_render.WorldRenderer 가 넣어 준다): room -> dict | None
        self.render_info: Callable[[str], Optional[Dict[str, Any]]] = lambda room: None
        self.render_busy: Callable[[], Optional[str]] = lambda: None

    # ---------- 카탈로그 / 방 ----------
    @property
    def catalog(self) -> Dict[str, Any]:
        try:
            mtime = self.catalog_path.stat().st_mtime
        except OSError:
            return {}
        if self._catalog is None or mtime != self._catalog_mtime:
            self._catalog = _read_json(self.catalog_path, {}) or {}
            self._catalog_mtime = mtime
        return self._catalog

    def rooms(self) -> List[str]:
        return list((self.catalog.get("rooms") or {}).keys())

    def check_room(self, room: str) -> str:
        if room not in self.rooms():
            raise ValueError(f"알 수 없는 방: {room}")
        return room

    @property
    def active(self) -> str:
        rooms = self.rooms()
        room = (_read_json(self.dir / "world.json", {}) or {}).get("active")
        if room in rooms:
            return room
        return rooms[0] if rooms else "classroom"

    def set_active(self, room: str) -> str:
        self.check_room(room)
        _write_json(self.dir / "world.json", {"active": room})
        return room

    # ---------- 배치 ----------
    def layout_path(self, room: str) -> Path:
        return self.dir / f"{room}.json"

    def default_layout(self, room: str) -> Optional[Dict[str, Any]]:
        cat = self.catalog
        return (cat.get("default_layouts") or {}).get(room) or cat.get("default_layout")

    def layout(self, room: str) -> Optional[Dict[str, Any]]:
        return _read_json(self.layout_path(room)) or self.default_layout(room)

    def has_layout(self, room: str) -> bool:
        return self.layout_path(room).exists()

    def validate(self, data: Any) -> Dict[str, Any]:
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            raise ValueError("items 목록이 없습니다")
        ids = set()
        for e in data["items"]:
            for k in ("id", "type", "x", "y", "rot"):
                if k not in e:
                    raise ValueError(f"항목에 {k} 가 없습니다: {e}")
            if e["id"] in ids:
                raise ValueError(f"중복 id: {e['id']}")
            ids.add(e["id"])
            e["x"], e["y"], e["rot"] = float(e["x"]), float(e["y"]), float(e["rot"])
        if not isinstance(data.setdefault("storage", []), list):
            raise ValueError("storage 는 목록이어야 합니다")
        arts = data.setdefault("arts", [])
        if not isinstance(arts, list):
            raise ValueError("arts 는 목록이어야 합니다")
        art_ids = set()
        for a in arts:
            for k in ("id", "image", "width", "aspect", "mount"):
                if k not in a:
                    raise ValueError(f"그림에 {k} 가 없습니다: {a.get('id')}")
            if a["id"] in art_ids:
                raise ValueError(f"중복 그림 id: {a['id']}")
            art_ids.add(a["id"])
            a["width"], a["aspect"] = float(a["width"]), float(a["aspect"])
            if a["width"] <= 0 or a["aspect"] <= 0:
                raise ValueError(f"그림 크기가 잘못됨: {a['id']}")
            if not self._art_file(a["image"]):
                raise ValueError(f"그림 경로가 artworks 밖입니다: {a['image']}")
        spot = data.get("doll_spot")
        if spot is not None:
            spot["x"], spot["y"] = float(spot["x"]), float(spot["y"])
        return data

    def save_layout(self, room: str, data: Any) -> Dict[str, Any]:
        self.check_room(room)
        data = self.validate(data)
        data["room"] = room
        path = self.layout_path(room)
        with self._lock:
            if path.exists():
                hist = self.dir / "history"
                hist.mkdir(parents=True, exist_ok=True)
                stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
                shutil.copy2(path, hist / f"{room}_{stamp}.json")
                old = sorted(hist.glob(f"{room}_*.json"))
                for p in old[:-HISTORY_KEEP]:
                    p.unlink()
            _write_json(path, data)
        log.info("world layout saved: %s items=%d arts=%d", room, len(data["items"]), len(data["arts"]))
        return data

    def reset_layout(self, room: str) -> None:
        self.check_room(room)
        path = self.layout_path(room)
        if path.exists():
            path.unlink()

    def tv_view(self) -> Dict[str, Any]:
        """state 브로드캐스트에 실리는 값: TV 가 그릴 방과 배치, 배경 렌더(있으면)"""
        room = self.active
        return {"room": room, "layout": self.layout(room), "render": self.render_info(room),
                "rendering": self.render_busy()}

    # ---------- 그림 ----------
    def _art_file(self, rel: str) -> Optional[Path]:
        if not isinstance(rel, str) or not rel.startswith("artworks/"):
            return None
        p = (self.art_dir / rel[len("artworks/"):]).resolve()
        return p if p.parent == self.art_dir.resolve() else None

    def artworks(self) -> List[Dict[str, Any]]:
        return _read_json(self.art_dir / "index.json", []) or []

    def add_artwork(self, body: Dict[str, Any]) -> tuple[Dict[str, Any], bool]:
        data_url = str(body.get("data", ""))
        if not data_url.startswith("data:") or ";base64," not in data_url:
            raise ValueError("이미지 데이터 형식이 아닙니다")
        head, b64 = data_url.split(";base64,", 1)
        mime = head[5:]
        if mime not in ART_TYPES:
            raise ValueError("PNG / JPG / WEBP 만 올릴 수 있습니다")
        raw = base64.b64decode(b64)
        if len(raw) > MAX_UPLOAD:
            raise ValueError("파일이 너무 큽니다 (60MB 이하)")
        w, h = int(body.get("width", 0)), int(body.get("height", 0))
        if w <= 0 or h <= 0:
            raise ValueError("이미지 크기를 알 수 없습니다")
        fname = hashlib.sha1(raw).hexdigest()[:16] + ART_TYPES[mime]
        rel = f"artworks/{fname}"
        with self._lock:
            items = self.artworks()
            found = next((a for a in items if a["file"] == rel), None)
            self.art_dir.mkdir(parents=True, exist_ok=True)
            if found and (self.art_dir / fname).exists():
                return found, False
            (self.art_dir / fname).write_bytes(raw)
            if found:
                return found, True
            name = os.path.splitext(os.path.basename(str(body.get("name") or fname)))[0][:80]
            entry = {"file": rel, "name": name, "width": w, "height": h,
                     "added": datetime.datetime.now().isoformat(timespec="seconds")}
            items.append(entry)
            _write_json(self.art_dir / "index.json", items)
            return entry, True

    def art_usage(self, rel: str) -> List[str]:
        used = []
        for room in self.rooms():
            lay = _read_json(self.layout_path(room), {}) or {}
            if any(a.get("image") == rel for a in lay.get("arts", [])):
                used.append(room)
        return used

    def delete_artwork(self, rel: str) -> None:
        with self._lock:
            items = self.artworks()
            entry = next((a for a in items if a["file"] == rel), None)
            if not entry:
                raise ValueError("없는 그림입니다")
            used = self.art_usage(rel)
            if used:
                raise ValueError("저장된 배치에서 사용 중입니다: " + ", ".join(used))
            items.remove(entry)
            _write_json(self.art_dir / "index.json", items)
            path = self._art_file(rel)
            if path and path.is_file():
                path.unlink()
