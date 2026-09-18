"""관리자 페이지에서 바꾸는 런타임 설정. data/settings.json 에 저장된다.

.env(Settings) 는 서버 기동 설정(포트, 제공자 종류)이고,
여기(RibbonConfig) 는 운영 중 바꾸는 값(목소리, 성격, 겉모습, 돌아다니기)이다.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict

from pydantic import BaseModel, Field


class RibbonLook(BaseModel):
    """3D 인형 겉모습. 색은 재질 기본색을 바꾼다. 고를 수 있는 옷은 캐릭터마다 다르다
    (client/src/world/doll.ts CHARACTERS: 리본이 onepiece|twopiece, 올리 apron|tee)"""
    outfit: str = "onepiece"
    hair: str = "#f48a9e"
    bow: str = "#de2834"
    dress: str = "#80d6be"       # 원피스 / 주름치마
    blouse: str = "#ffe896"      # 투피스 블라우스


class RibbonConfig(BaseModel):
    name: str = "리본"
    voice: str = "F1"            # supertonic M1~M5, F1~F5
    speed: float = 1.05          # 0.7 ~ 2.0
    steps: int = 8               # 5 ~ 12
    pitch: float = 0.0           # 반음 단위 -6 ~ +8. 어린아이 느낌은 +3 ~ +5
    max_sentences: int = 3
    persona_extra: str = ""      # 시스템 프롬프트 뒤에 붙는 추가 지시문
    ack_enabled: bool = True     # 인식 직후 "알았어, 잠깐 생각해 볼게!" 같은 즉시 반응
    filler_enabled: bool = True  # 답이 늦으면 "음..." 추임새
    filler_delay_s: float = 1.5  # 반응이 끝난 뒤 이만큼 조용하면 첫 추임새
    filler_interval_s: float = 4.0  # 그 뒤 추임새 간격
    look: RibbonLook = Field(default_factory=RibbonLook)
    character: str = "ribbon"    # TV 에 나오는 캐릭터: ribbon (여자) | ollie (남자)
    friend: str = ""             # 같이 나오는 친구 캐릭터 (빈 값이면 혼자). 친구는 부르지 않아도 알아서 돌아다닌다
    # 맵에서 돌아다니기
    wander: bool = True          # 끄면 "부르면 오는 자리"에 서 있는다
    walk_speed: float = 1.0      # 배율 (1 = 초속 약 0.5m)
    return_after_s: float = 8.0  # 대화가 끝나고 이만큼 지나면 다시 돌아다닌다


class AppConfig(BaseModel):
    ribbon: RibbonConfig = Field(default_factory=RibbonConfig)


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
