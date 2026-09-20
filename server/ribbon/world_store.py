"""3D 맵(방 + 가구 배치 + 걸린 그림) 저장소.

모델과 카탈로그는 Character_Creator(블렌더)에서 만든 것을 client/public/world/ 에 둔다 (tools/sync_world.py).
배치는 방마다 data/world/<room>.json 이고, 형식은 Character_Creator 의 layout.json 과 같다.
  - 파일이 없으면 catalog.json 의 기본 배치를 쓴다.
  - 저장할 때마다 이전 파일은 data/world/history/ 에 보관한다.
  - TV 에 보여줄 방은 data/world/world.json 의 active.
그림 파일은 data/artworks/ (index.json 이 목록), 배치의 image 는 "artworks/<파일>" 로 적는다.

아이별 전시실
  - 아이마다 방 하나: "kid-<아이 id>". 가구는 gallery 방 것을 그대로 쓰고, 걸린 그림만 아이마다 다르다.
  - 그림은 data/world/kid-<아이 id>.json 에 arts 만 저장한다.
  - 배경 렌더는 아이마다 만들지 않는다. 그림을 뺀 전시실을 "kidbase" 로 한 장만 렌더해 같이 쓰고,
    그림은 TV 가 three.js 로 그 위에 그린다 (arts_live). 그래서 그림을 올리면 렌더를 기다리지 않는다.
"""
from __future__ import annotations

import base64
import datetime
import hashlib
import json
import logging
import os
import secrets
import shutil
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

log = logging.getLogger("ribbon.world")

ART_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
KID_ROOM = "kid-"          # 아이 전시실 방 id 접두어 (kid-<아이 id>)
KID_BASE = "kidbase"       # 아이 전시실이 같이 쓰는 배경 (그림을 뺀 전시실)
HALL_SEP = "@"             # 전시실 2실부터: kid-<아이 id>@2 (1실은 kid-<아이 id> 그대로)
MAX_HALLS = 9
LIGHT_MIN, LIGHT_MAX = 0.2, 1.6   # 전시실 조명 밝기 (1 = 렌더 그대로)
KID_SHELL = "gallery"      # 아이 전시실의 방 모양·가구는 전시장 것을 쓴다
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
        # 아이 명단을 보는 함수 (main.py 가 넣어 준다). 아이 전시실이 있는 방인지 확인할 때 쓴다
        self.kid_ids: Callable[[], List[str]] = lambda: []
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
        """편집기에서 고를 수 있는 방 (아이 전시실은 뺀다)"""
        return list((self.catalog.get("rooms") or {}).keys())

    # ---------- 아이 전시실 ----------
    @staticmethod
    def kid_room(kid_id: str, hall: int = 1) -> str:
        return f"{KID_ROOM}{kid_id}" if hall <= 1 else f"{KID_ROOM}{kid_id}{HALL_SEP}{hall}"

    @staticmethod
    def kid_of(room: str) -> Optional[str]:
        return room[len(KID_ROOM):].split(HALL_SEP)[0] if room.startswith(KID_ROOM) else None

    @staticmethod
    def hall_of(room: str) -> int:
        """몇 실인가 (1부터). 아이 전시실이 아니거나 숫자가 아니면 1"""
        tail = room.split(HALL_SEP, 1)[1] if room.startswith(KID_ROOM) and HALL_SEP in room else ""
        return int(tail) if tail.isdigit() and int(tail) >= 1 else 1

    def halls(self, kid_id: str) -> int:
        """그 아이 전시실이 몇 실까지 있나 (1실 파일에 적어 둔다)"""
        n = (_read_json(self.layout_path(self.kid_room(kid_id)), {}) or {}).get("halls", 1)
        return max(1, min(MAX_HALLS, int(n))) if isinstance(n, (int, float)) else 1

    def kid_rooms(self, kid_id: str) -> List[str]:
        return [self.kid_room(kid_id, h) for h in range(1, self.halls(kid_id) + 1)]

    def set_halls(self, kid_id: str, count: int) -> int:
        """전시실 수를 바꾼다. 줄이면 뒤쪽 실의 걸린 그림 목록은 지운다 (사진 파일은 남는다)"""
        count = max(1, min(MAX_HALLS, int(count)))
        with self._lock:
            old = self.halls(kid_id)
            first = self.layout_path(self.kid_room(kid_id))
            data = _read_json(first, {}) or {"room": self.kid_room(kid_id), "kid_id": kid_id, "arts": []}
            data["halls"] = count
            _write_json(first, data)
            for h in range(count + 1, old + 1):
                self.layout_path(self.kid_room(kid_id, h)).unlink(missing_ok=True)
        active = (_read_json(self.dir / "world.json", {}) or {}).get("active") or ""
        if self.kid_of(active) == kid_id and self.hall_of(active) > count:
            _write_json(self.dir / "world.json", {"active": self.kid_room(kid_id)})
        return count

    def shell_room(self, room: str) -> str:
        """그 방의 모양·조명을 어디서 가져오는가 (블렌더 렌더가 쓴다)"""
        if room == KID_BASE or self.kid_of(room):
            return KID_SHELL
        return room

    def forget_kid_room(self, room: str) -> None:
        """아이를 지울 때 그 아이 전시실 파일도 지운다 (그림 파일 자체는 artworks 에 남는다)"""
        kid = self.kid_of(room) or ""
        for h in range(1, MAX_HALLS + 1):       # 2실, 3실… 도 같이
            self.layout_path(self.kid_room(kid, h)).unlink(missing_ok=True)
        if self.kid_of((_read_json(self.dir / "world.json", {}) or {}).get("active") or "") == kid:
            _write_json(self.dir / "world.json", {"active": self.rooms()[0] if self.rooms() else "classroom"})

    # ---------- 부모님께 보내는 전시실 주소 ----------
    def share_token(self, kid_id: str) -> str:
        """그 아이 전시실을 로그인 없이 볼 수 있는 주소의 열쇠 (없으면 만든다). data/world/shares.json"""
        with self._lock:
            shares = _read_json(self.dir / "shares.json", {}) or {}
            for token, kid in shares.items():
                if kid == kid_id:
                    return token
            token = secrets.token_urlsafe(12)
            shares[token] = kid_id
            _write_json(self.dir / "shares.json", shares)
            return token

    def shared_kid(self, token: str) -> Optional[str]:
        kid = (_read_json(self.dir / "shares.json", {}) or {}).get(token)
        return kid if kid in self.kid_ids() else None

    def render_rooms(self) -> List[str]:
        """배경을 렌더해 두어야 하는 방 (아이 전시실은 kidbase 한 장을 같이 쓴다)"""
        return self.rooms() + [KID_BASE]

    def check_room(self, room: str) -> str:
        kid = self.kid_of(room)
        if kid is not None:
            if kid not in self.kid_ids():
                raise ValueError(f"없는 아이입니다: {kid}")
            if room != self.kid_room(kid, self.hall_of(room)) or self.hall_of(room) > self.halls(kid):
                raise ValueError(f"없는 전시실입니다: {room}")
            return room
        if room == KID_BASE:
            return room
        if room not in self.rooms():
            raise ValueError(f"알 수 없는 방: {room}")
        return room

    @property
    def active(self) -> str:
        """TV 에 보여 줄 방. 아이 전시실도 될 수 있다 (그 아이가 지워졌으면 첫 방으로)"""
        rooms = self.rooms()
        room = (_read_json(self.dir / "world.json", {}) or {}).get("active")
        try:
            return self.check_room(str(room))
        except ValueError:
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
        if room == KID_BASE:                    # 그림을 뺀 전시실 (아이 전시실 배경용)
            base = self.layout(KID_SHELL)
            return {**base, "room": KID_BASE, "shell": KID_SHELL, "arts": []} if base else None
        kid = self.kid_of(room)
        if kid is not None:                     # 가구는 전시실 것, 그림은 그 아이 것
            base = self.layout(KID_SHELL)
            if base is None:
                return None
            mine = _read_json(self.layout_path(room), {}) or {}
            # shell: 방 모양·벽(그림 거는 면)을 어디서 가져오는지 TV 에 알려 준다
            return {**base, "room": room, "shell": KID_SHELL, "kid_id": kid, "arts": mine.get("arts", []),
                    "light": mine.get("light", 1.0), "hall": self.hall_of(room), "halls": self.halls(kid)}
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
        kid = self.kid_of(room)
        if kid is not None:                     # 아이 전시실은 걸린 그림만 저장한다
            light = data.get("light", 1.0)
            data = self.validate({**(self.layout(KID_SHELL) or {"items": []}), "arts": data.get("arts", [])})
            saved = {"room": room, "kid_id": kid, "arts": data["arts"],
                     "light": max(LIGHT_MIN, min(LIGHT_MAX, float(light)))}
            with self._lock:
                if self.hall_of(room) == 1:     # 전시실 수는 1실 파일에 적혀 있다
                    saved["halls"] = self.halls(kid)
                _write_json(self.layout_path(room), saved)
            log.info("kid gallery saved: %s arts=%d", room, len(saved["arts"]))
            return self.layout(room) or saved
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
        view = {"room": room, "layout": self.layout(room), "render": self.render_info(room),
                "rendering": self.render_busy()}
        if self.kid_of(room):
            view["kid_id"] = self.kid_of(room)
        return view

    # ---------- 그림 ----------
    def _art_file(self, rel: str) -> Optional[Path]:
        if not isinstance(rel, str) or not rel.startswith("artworks/"):
            return None
        p = (self.art_dir / rel[len("artworks/"):]).resolve()
        return p if p.parent == self.art_dir.resolve() else None

    def artworks(self, kid_id: Optional[str] = None) -> List[Dict[str, Any]]:
        items = _read_json(self.art_dir / "index.json", []) or []
        return [a for a in items if a.get("kid_id") == kid_id] if kid_id else items

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
                     "kid_id": str(body["kid_id"]) if body.get("kid_id") else None,
                     "added": datetime.datetime.now().isoformat(timespec="seconds")}
            items.append(entry)
            _write_json(self.art_dir / "index.json", items)
            return entry, True

    def art_usage(self, rel: str) -> List[str]:
        used = []
        for room in self.rooms() + [r for k in self.kid_ids() for r in self.kid_rooms(k)]:
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
