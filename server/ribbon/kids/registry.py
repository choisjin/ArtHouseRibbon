"""아이 명단 로딩과 마이크 채널/자리 매핑."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional

from ..protocol import KidInfo


class KidRegistry:
    def __init__(self, kids: List[KidInfo]):
        self._by_id: Dict[str, KidInfo] = {k.id: k for k in kids}

    @classmethod
    def load(cls, path: Path) -> "KidRegistry":
        if not path.exists():
            return cls([])
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls([KidInfo(**k) for k in data.get("kids", [])])

    def all(self) -> List[KidInfo]:
        return list(self._by_id.values())

    def get(self, kid_id: str) -> Optional[KidInfo]:
        return self._by_id.get(kid_id)

    def by_channel(self, channel: int) -> Optional[KidInfo]:
        for k in self._by_id.values():
            if k.mic_channel == channel:
                return k
        return None

    def assign_channel(self, kid_id: str, channel: int) -> None:
        """등원 시 얼굴 인식 결과로 마이크 채널을 묶을 때 사용."""
        for k in self._by_id.values():
            if k.mic_channel == channel and k.id != kid_id:
                k.mic_channel = None
        self._by_id[kid_id].mic_channel = channel

    def set_present(self, kid_id: str, present: bool) -> Optional[KidInfo]:
        kid = self._by_id.get(kid_id)
        if kid:
            kid.present = present
        return kid
