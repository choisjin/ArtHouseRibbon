"""방 구성(data/room.json) 저장소. 그림은 client/public/room/*.png, 위치·앵커는 이 JSON.

첫 실행에 data/room.example.json 을 복사한다 (kids.json 과 같은 방식). 검증은 느슨하게:
레이어 목록은 dict 그대로 두고, 앵커·투시·배율만 모양을 확인한다.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List

from pydantic import BaseModel, Field, ValidationError

log = logging.getLogger("ribbon.room")


class XY(BaseModel):
    x: float
    y: float


class Rect(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float


class FloorPos(BaseModel):
    bx: float
    t: float


class Perspective(BaseModel):
    vp: XY
    back: Rect


class Anchors(BaseModel):
    seats: List[FloorPos] = Field(min_length=1, max_length=8)
    door: FloorPos
    ribbon: FloorPos


class Scale(BaseModel):
    avatar: float = 1.0
    ribbon: float = 0.8


class View(BaseModel):
    w: int = 640
    h: int = 360


class RoomSpec(BaseModel):
    version: int = 2
    view: View = Field(default_factory=View)
    perspective: Perspective
    layers: List[Dict[str, Any]] = []
    anchors: Anchors
    frameSlots: List[Dict[str, float]] = []
    scale: Scale = Field(default_factory=Scale)


class RoomStore:
    def __init__(self, path: Path):
        self.path = path
        self.example = path.with_name("room.example.json")
        self.spec: RoomSpec = self._load()

    def _load(self) -> RoomSpec:
        if not self.path.exists() and self.example.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(self.example.read_text(encoding="utf-8"), encoding="utf-8")
        for p in (self.path, self.example):
            if p.exists():
                try:
                    return RoomSpec(**json.loads(p.read_text(encoding="utf-8")))
                except (ValidationError, json.JSONDecodeError) as e:
                    log.warning("room 파일이 깨져 건너뜀 %s: %s", p, e)
        return RoomSpec(perspective=Perspective(vp=XY(x=320, y=150), back=Rect(x0=172, y0=60, x1=470, y1=228)),
                        anchors=Anchors(seats=[FloorPos(bx=320, t=0.3)], door=FloorPos(bx=405, t=0.02),
                                        ribbon=FloorPos(bx=440, t=0.7)))

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.spec.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")

    def replace(self, data: Dict[str, Any]) -> RoomSpec:
        """관리자 페이지 저장. ValidationError 는 호출자가 400 으로 바꾼다."""
        self.spec = RoomSpec(**data)
        self.save()
        return self.spec

    def reset(self) -> RoomSpec:
        if self.path.exists():
            self.path.unlink()
        self.spec = self._load()
        return self.spec
