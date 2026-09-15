"""관리자 페이지에서 바꾸는 런타임 설정. data/settings.json 에 저장된다.

.env(Settings) 는 서버 기동 설정(포트, 제공자 종류)이고,
여기(RibbonConfig) 는 운영 중 바꾸는 값(목소리, 성격, 색)이다.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List

from pydantic import BaseModel, Field


class RibbonColors(BaseModel):
    body: str = "#ff7aa8"
    wing: str = "#ff9ec4"
    bow: str = "#ffd54a"
    cheek: str = "#ff4d88"


class RibbonConfig(BaseModel):
    name: str = "리본"
    voice: str = "F1"            # supertonic M1~M5, F1~F5
    speed: float = 1.05          # 0.7 ~ 2.0
    steps: int = 8               # 5 ~ 12
    max_sentences: int = 3
    persona_extra: str = ""      # 시스템 프롬프트 뒤에 붙는 추가 지시문
    colors: RibbonColors = Field(default_factory=RibbonColors)
    sprite_url: str | None = None


class AvatarOptions(BaseModel):
    hair: List[str] = ["short", "bowl", "twin", "spiky", "long", "curly", "bun"]


class AppConfig(BaseModel):
    ribbon: RibbonConfig = Field(default_factory=RibbonConfig)
    avatar_options: AvatarOptions = Field(default_factory=AvatarOptions)


class ConfigStore:
    def __init__(self, path: Path):
        self.path = path
        self.config = AppConfig()
        self.load()

    def load(self) -> AppConfig:
        if self.path.exists():
            try:
                self.config = AppConfig(**json.loads(self.path.read_text(encoding="utf-8")))
            except Exception:  # noqa: BLE001 - 깨진 파일이면 기본값으로
                self.config = AppConfig()
        return self.config

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.config.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")

    def update_ribbon(self, data: Dict) -> RibbonConfig:
        merged = self.config.ribbon.model_dump()
        merged.update({k: v for k, v in data.items() if v is not None})
        self.config.ribbon = RibbonConfig(**merged)
        self.save()
        return self.config.ribbon
