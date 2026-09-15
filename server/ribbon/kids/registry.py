"""아이 명단 로딩/저장과 마이크 채널/자리 매핑."""
from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from ..protocol import KidInfo


class KidRegistry:
    def __init__(self, kids: List[KidInfo], path: Optional[Path] = None):
        self._by_id: Dict[str, KidInfo] = {k.id: k for k in kids}
        self.path = path

    @classmethod
    def load(cls, path: Path) -> "KidRegistry":
        if not path.exists():
            # 처음 실행이면 예제 명단을 복사해 시작한다 (kids.json 은 git 에 없음)
            example = path.with_name("kids.example.json")
            if example.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
            else:
                return cls([], path)
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls([KidInfo(**k) for k in data.get("kids", [])], path)

    def save(self) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # present(출석) 는 저장하지 않는다 - 매 수업 등원 때 다시 정해진다
        kids = [{**k.model_dump(), "present": False} for k in self._by_id.values()]
        self.path.write_text(json.dumps({"kids": kids}, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- 조회 ----
    def all(self) -> List[KidInfo]:
        return list(self._by_id.values())

    def get(self, kid_id: str) -> Optional[KidInfo]:
        return self._by_id.get(kid_id)

    def by_channel(self, channel: int) -> Optional[KidInfo]:
        for k in self._by_id.values():
            if k.mic_channel == channel:
                return k
        return None

    # ---- 변경 ----
    def upsert(self, data: dict) -> KidInfo:
        """관리자 페이지에서 추가/수정. id 가 없으면 새로 만든다."""
        kid_id = data.get("id") or self._new_id(data.get("name", "kid"))
        existing = self._by_id.get(kid_id)
        merged = existing.model_dump() if existing else {"id": kid_id, "name": "", "avatar": {}}
        merged.update({k: v for k, v in data.items() if k != "id"})
        merged["id"] = kid_id
        kid = KidInfo(**merged)
        if kid.mic_channel is not None:
            for other in self._by_id.values():
                if other.id != kid.id and other.mic_channel == kid.mic_channel:
                    other.mic_channel = None
        self._by_id[kid_id] = kid
        self.save()
        return kid

    def remove(self, kid_id: str) -> bool:
        if kid_id in self._by_id:
            del self._by_id[kid_id]
            self.save()
            return True
        return False

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

    def _new_id(self, name: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "", name.lower()) or "kid"
        return f"kid_{slug}_{uuid.uuid4().hex[:6]}"
