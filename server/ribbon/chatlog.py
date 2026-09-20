"""대화 로그 (data/logs/YYYY-MM-DD.jsonl).

관리자 '로그' 탭에서 날짜별로 본다. 화면에 잠깐 떴다 사라지는 대시보드 대화와 달리 파일로 남는다.
오가는 메시지(main.broadcast)를 지나가며 기록할 것만 골라 적는다: 아이 말, 리본이 말, 호출 버튼, 약속.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger("ribbon.chatlog")
KEEP_DAYS = 400


class ChatLog:
    def __init__(self, folder: Path):
        self.folder = folder

    def _path(self, day: str) -> Path:
        return self.folder / f"{day}.jsonl"

    def note(self, msg: Dict[str, Any], name_of, ribbon_name: str = "리본") -> None:
        """브로드캐스트 메시지 하나를 보고 기록할 것이면 적는다. name_of(kid_id) 는 아이 이름을 준다"""
        kind = msg.get("type")
        if kind == "transcript":
            who = name_of(msg.get("kid_id")) or f"마이크 {int(msg.get('channel', 0)) + 1}"
            self.add("kid", who, str(msg.get("text") or ""))
        elif kind == "speak":
            self.add("ribbon", ribbon_name, str(msg.get("text") or ""))
        elif kind == "button":
            chans = ", ".join(str(c + 1) for c in msg.get("channels") or [])
            self.add("button", "호출 버튼", f"마이크 {chans} 듣는 중")
        elif kind == "memory.changed":
            who = name_of(msg.get("kid_id")) or "모두"
            for t in msg.get("added") or []:
                self.add("memory", "약속", f"{t} ({who})")
            for t in msg.get("removed") or []:
                self.add("memory", "약속 취소", f"{t} ({who})")

    def add(self, kind: str, who: str, text: str) -> None:
        text = text.strip()
        if not text:
            return
        now = dt.datetime.now()
        row = {"at": now.strftime("%H:%M:%S"), "kind": kind, "who": who, "text": text}
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            with self._path(now.strftime("%Y-%m-%d")).open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError:
            log.exception("대화 로그를 적지 못했습니다")

    def days(self) -> List[str]:
        """기록이 있는 날짜들 (최근 것부터)"""
        if not self.folder.exists():
            return []
        return sorted((p.stem for p in self.folder.glob("*.jsonl")), reverse=True)[:KEEP_DAYS]

    def read(self, day: Optional[str] = None, limit: int = 1000) -> List[Dict[str, Any]]:
        """그날의 기록 (오래된 것부터, 많으면 뒤에서 limit 개)"""
        day = day or dt.date.today().isoformat()
        path = self._path(day)
        if not path.exists():
            return []
        rows: List[Dict[str, Any]] = []
        try:
            with path.open(encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rows.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        except OSError:
            log.exception("대화 로그를 읽지 못했습니다: %s", path)
        return rows[-limit:]
