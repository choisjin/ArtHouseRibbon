"""장치 현황판: TV 화면들이 알려 온 소리 출력 장치와 웹캠 상태.

관리자 '설정' 탭이 이것을 보고, 고른 값을 device.control 로 그 TV 에 전달한다 (main.py 가 중계).
출력 장치·웹캠은 TV 가 켜진 컴퓨터에 달린 것이라 서버가 직접 바꿀 수 없다. TV 화면이 닫히면 현황판에서 빠진다.
웹캠 영상은 TV 브라우저 안에서만 쓰고, 여기에는 켜짐 여부와 얼굴 수 같은 상태만 온다.
(마이크는 관리자 페이지가 직접 받으므로 여기에 없다: client/src/audio/mic.ts)
"""
from __future__ import annotations

import time
from typing import Any, Dict, Optional, Tuple

KINDS = ("output", "camera")


class DeviceBoard:
    def __init__(self) -> None:
        # (agent, kind) -> {"agent", "kind", "role", "host", "seen", **상태}. agent = "브라우저 id/역할" (main.Hub.agent)
        self._items: Dict[Tuple[str, str], Dict[str, Any]] = {}

    def update(self, agent: str, kind: str, role: str, host: str, status: Dict[str, Any],
               now: Optional[float] = None) -> bool:
        """상태를 적는다. 바뀐 것이 있으면 True (관리자 화면을 새로 그릴 일)"""
        if kind not in KINDS or not agent:
            return False
        key = (agent, kind)
        old = self._items.get(key)
        item = {k: v for k, v in status.items() if k not in ("type", "kind")}
        item.update(agent=agent, kind=kind, role=role, host=host, seen=now or time.time())
        self._items[key] = item
        if old is None:
            return True
        strip = lambda d: {k: v for k, v in d.items() if k != "seen"}  # noqa: E731
        return strip(old) != strip(item)

    def drop_agent(self, agent: str) -> bool:
        keys = [k for k in self._items if k[0] == agent]
        for k in keys:
            del self._items[k]
        return bool(keys)

    def snapshot(self) -> Dict[str, Any]:
        items = sorted(self._items.values(), key=lambda d: (d["kind"], d["host"], d["agent"]))
        return {"type": "devices",
                "outputs": [d for d in items if d["kind"] == "output"],
                "cameras": [d for d in items if d["kind"] == "camera"]}
