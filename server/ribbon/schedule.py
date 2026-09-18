"""수업 시간표.

- 아이마다 정규 수업 시간(KidInfo.schedule: 요일·시작·끝)을 정해 두면 매주 그 시간에 수업이 생긴다.
- 관리자 대시보드에서 수업을 끌어 옮기면 **그날 하루만** 바뀐다 (data/schedule.json 의 overrides).
  옮긴 수업은 원래 날짜·시작 시각(orig_date, orig_start)으로 알아본다. 같은 수업을 다시 옮기면 앞의 것을 덮어쓴다.
- 결석으로 표시하면 그날 수업이 빠진다 (cancelled).

순수 로직(occurrences)과 파일 저장(ScheduleStore)을 나눠 테스트하기 쉽게 했다.
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from pydantic import BaseModel

from .protocol import KidInfo

DAY_START = "15:00"
DAY_END = "19:00"


class Override(BaseModel):
    kid_id: str
    orig_date: str              # 원래 수업 날짜 "YYYY-MM-DD"
    orig_start: str             # 원래 시작 "HH:MM"
    date: str = ""              # 옮긴 날짜 (cancelled 면 비움)
    start: str = ""
    end: str = ""
    cancelled: bool = False


class Occurrence(BaseModel):
    kid_id: str
    date: str
    start: str
    end: str
    orig_date: str
    orig_start: str
    moved: bool = False
    cancelled: bool = False


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _hhmm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def valid_time(s: str) -> bool:
    try:
        m = _minutes(s)
    except (ValueError, AttributeError):
        return False
    return 0 <= m < 24 * 60


def _days(start: dt.date, end: dt.date) -> Iterable[dt.date]:
    d = start
    while d <= end:
        yield d
        d += dt.timedelta(days=1)


def occurrences(kids: List[KidInfo], overrides: List[Override], start: dt.date, end: dt.date,
                include_cancelled: bool = False) -> List[Occurrence]:
    """start~end(포함) 사이의 수업. 정규 수업에 하루짜리 변경을 적용한 결과를 날짜·시각 순으로 준다."""
    by_key: Dict[tuple, Override] = {(o.kid_id, o.orig_date, o.orig_start): o for o in overrides}
    out: List[Occurrence] = []
    # 정규 수업 (원래 날짜가 범위 안) - 옮겼으면 옮긴 날짜가 범위 안일 때만.
    # 범위 밖에서 범위 안으로 옮겨 온 수업도 있어서 원래 날짜는 앞뒤로 넉넉히 훑는다
    scan_from = start - dt.timedelta(days=62)
    scan_to = end + dt.timedelta(days=62)
    for kid in kids:
        for slot in kid.schedule:
            for d in _days(scan_from, scan_to):
                if d.weekday() != slot.day:
                    continue
                ds = d.isoformat()
                ov = by_key.get((kid.id, ds, slot.start))
                if ov is None:
                    if start <= d <= end:
                        out.append(Occurrence(kid_id=kid.id, date=ds, start=slot.start, end=slot.end,
                                              orig_date=ds, orig_start=slot.start))
                    continue
                if ov.cancelled:
                    if include_cancelled and start <= d <= end:
                        out.append(Occurrence(kid_id=kid.id, date=ds, start=slot.start, end=slot.end,
                                              orig_date=ds, orig_start=slot.start, cancelled=True))
                    continue
                nd = dt.date.fromisoformat(ov.date)
                if start <= nd <= end:
                    out.append(Occurrence(kid_id=kid.id, date=ov.date, start=ov.start, end=ov.end,
                                          orig_date=ds, orig_start=slot.start, moved=True))
    # 정규 수업이 바뀌어 주인을 잃은 변경 기록은 여기서 자연히 무시된다
    out.sort(key=lambda o: (o.date, o.start, o.kid_id))
    return out


def move(overrides: List[Override], kid: KidInfo, orig_date: str, orig_start: str,
         date: str, start: str) -> Override:
    """수업 하나를 그날만 옮긴다. 수업 길이는 그대로. 원래 자리로 옮기면 변경을 지운다."""
    slot = _slot_of(kid, orig_date, orig_start)
    length = _minutes(slot.end) - _minutes(slot.start)
    end = _hhmm(min(_minutes(start) + length, 24 * 60 - 1))
    _drop(overrides, kid.id, orig_date, orig_start)
    ov = Override(kid_id=kid.id, orig_date=orig_date, orig_start=orig_start, date=date, start=start, end=end)
    if date == orig_date and start == orig_start:
        return ov                 # 제자리 = 변경 없음
    overrides.append(ov)
    return ov


def cancel(overrides: List[Override], kid: KidInfo, orig_date: str, orig_start: str) -> Override:
    _slot_of(kid, orig_date, orig_start)
    _drop(overrides, kid.id, orig_date, orig_start)
    ov = Override(kid_id=kid.id, orig_date=orig_date, orig_start=orig_start, cancelled=True)
    overrides.append(ov)
    return ov


def restore(overrides: List[Override], kid_id: str, orig_date: str, orig_start: str) -> bool:
    return _drop(overrides, kid_id, orig_date, orig_start)


def _slot_of(kid: KidInfo, orig_date: str, orig_start: str):
    wd = dt.date.fromisoformat(orig_date).weekday()
    for s in kid.schedule:
        if s.day == wd and s.start == orig_start:
            return s
    raise ValueError(f"{kid.name} 은(는) {orig_date} {orig_start} 에 정규 수업이 없습니다")


def _drop(overrides: List[Override], kid_id: str, orig_date: str, orig_start: str) -> bool:
    n = len(overrides)
    overrides[:] = [o for o in overrides
                    if not (o.kid_id == kid_id and o.orig_date == orig_date and o.orig_start == orig_start)]
    return len(overrides) != n


class ScheduleStore:
    """data/schedule.json - 하루짜리 변경만 저장한다 (정규 수업은 아이 명단 kids.json 에 있다)"""

    def __init__(self, path: Path):
        self.path = path
        self.overrides: List[Override] = []
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                self.overrides = [Override(**o) for o in data.get("overrides", [])]
            except Exception:  # noqa: BLE001 - 깨진 파일이면 비우고 시작
                self.overrides = []

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # 두 달 넘게 지난 변경은 정리한다
        cutoff = (dt.date.today() - dt.timedelta(days=62)).isoformat()
        self.overrides = [o for o in self.overrides if max(o.orig_date, o.date or "") >= cutoff]
        self.path.write_text(json.dumps({"overrides": [o.model_dump() for o in self.overrides]},
                                        ensure_ascii=False, indent=1), encoding="utf-8")

    def drop_kid(self, kid_id: str) -> None:
        self.overrides = [o for o in self.overrides if o.kid_id != kid_id]
        self.save()

    def occurrences(self, kids: List[KidInfo], start: dt.date, end: dt.date,
                    include_cancelled: bool = False) -> List[Occurrence]:
        return occurrences(kids, self.overrides, start, end, include_cancelled)

    def current(self, kids: List[KidInfo], now: Optional[dt.datetime] = None) -> List[Occurrence]:
        """지금 수업 중이거나 30분 안에 시작하는 수업"""
        now = now or dt.datetime.now()
        today = now.date()
        m = now.hour * 60 + now.minute
        return [o for o in self.occurrences(kids, today, today)
                if _minutes(o.start) - 30 <= m < _minutes(o.end)]
