"""가져가는 전시실: 아이 전시실을 **.html 한 장**으로 묶는다 (2026-09-21).

학원을 그만두는 아이에게 통째로 주려고 만든다. 그림·배경 사진·뷰어 자바스크립트를 모두 data: 주소로 파일 안에
박아 넣어서, 서버도 인터넷도 없이 폰에서 그냥 열면 보인다.
  - 전시실 탭: 파노라마 배경 + 걸린 그림(액자·여백·배경색·필터 그대로), 쓸어서 둘러보기
  - 작품 목록 탭: 벽에 걸지 않은 것까지 그 아이의 모든 작품
뷰어는 client/src/export/viewer.ts 를 따로 묶은 client/dist-export/viewer.js (npm run build 가 같이 만든다).
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger("ribbon.export")

MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
        ".glb": "model/gltf-binary"}
# 캐릭터 모델은 하나에 10MB 쯤이라 세워 둔 것만 담는다 (world_store.character_file)
BIG = 60 * 1024 * 1024        # 이보다 커지면 로그로 알려 준다 (폰에서 열기 버겁다)


def _data_url(path: Path) -> Optional[str]:
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    mime = MIME.get(path.suffix.lower(), "application/octet-stream")
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def _pano_path(render_dir: Path, info: Optional[Dict[str, Any]]) -> Optional[Path]:
    """렌더 정보의 파노라마 주소(/world-render/xxx.jpg?v=1) 를 파일 경로로"""
    url = (info or {}).get("pano")
    if not url:
        return None
    name = url.split("?")[0].rsplit("/", 1)[-1]
    path = render_dir / name
    return path if path.is_file() else None


def build(world: Any, kid: Any, viewer_js: str, render_dir: Path) -> tuple[str, str]:
    """(파일 이름, HTML). 그 아이의 전시실 전부와 작품 전부를 담는다"""
    shell = world.shell_room(world.kid_room(kid.id))
    room = (world.catalog.get("rooms") or {}).get(shell) or {}
    halls: List[Dict[str, Any]] = []
    images: Dict[str, str] = {}
    for room_id in world.kid_rooms(kid.id):
        lay = world.layout(room_id) or {}
        info = world.render_info(room_id)
        pano = _pano_path(render_dir, info)
        halls.append({
            "light": lay.get("light", 1.0),
            "guide": lay.get("guide"),
            "pano": _data_url(pano) if pano else None,
            "arts": [{k: a[k] for k in ("image", "width", "aspect", "frame", "mount", "u", "v", "bg", "pad", "fx")
                      if k in a} for a in lay.get("arts", [])],
        })

    artworks = []
    for a in world.artworks(kid.id):
        url = _data_url(world.art_dir.parent / a["file"])
        if not url:
            log.warning("내보내기: 그림 파일을 못 읽었습니다 %s", a["file"])
            continue
        images[a["file"]] = url
        artworks.append({k: a.get(k) for k in ("file", "name", "made", "note", "bg", "pad", "width", "height")})
    for hall in halls:                              # 목록에서 지워진 그림이 벽에 남아 있을 수도 있다
        for art in hall["arts"]:
            if art["image"] not in images:
                url = _data_url(world.art_dir.parent / art["image"])
                if url:
                    images[art["image"]] = url

    guides: Dict[str, str] = {}                     # 세워 둔 캐릭터의 glb (쓰는 것만)
    for hall in halls:
        who = (hall.get("guide") or {}).get("who")
        if not who or who in guides:
            continue
        path = world.character_file(who)
        url = _data_url(path) if path else None
        if url:
            guides[who] = url
        else:
            log.warning("내보내기: 캐릭터 모델을 못 읽었습니다 %s", who)
            hall["guide"] = None

    data = {
        "kid": kid.name,
        "guides": guides,
        "made": dt.date.today().isoformat(),
        "room": {
            "unit_per_m": room.get("unit_per_m", 2.2222),
            "front_y": room.get("front_y", -8.0),
            "back_y": room.get("back_y", 8.0),
            "mounts": [{k: m[k] for k in ("id", "name", "origin", "normal", "up", "width", "height")}
                       for m in room.get("mounts", []) if not m.get("ledge")],
        },
        "halls": halls,
        "artworks": artworks,
        "images": images,
    }
    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    html = f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{kid.name}의 전시실</title>
</head>
<body>
<noscript>이 파일은 자바스크립트로 전시실을 그립니다. 크롬·사파리 같은 브라우저로 열어 주세요.</noscript>
<script>window.__GALLERY__ = {blob};</script>
<script>{viewer_js}</script>
</body>
</html>
"""
    if len(html.encode()) > BIG:
        log.warning("내보낸 전시실이 큽니다: %s (%.1fMB)", kid.name, len(html.encode()) / 1024 / 1024)
    safe = re.sub(r'[\\/:*?"<>|]', "_", kid.name) or "전시실"
    return f"{safe}_전시실.html", html
