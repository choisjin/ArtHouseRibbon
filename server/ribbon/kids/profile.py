"""아이 인적사항을 대화에 쓰는 도우미 (부르는 이름, 생일로 계산한 나이, 프롬프트에 넣을 줄들)."""
from __future__ import annotations

import datetime as dt
from typing import List, Optional

from ..protocol import KidInfo


def _date(s: str) -> Optional[dt.date]:
    try:
        return dt.date.fromisoformat(s.strip()) if s and s.strip() else None
    except ValueError:
        return None


def call_name(kid: KidInfo) -> str:
    """리본이가 부르는 이름: 별명이 있으면 별명"""
    return (kid.nickname or "").strip() or kid.name


def age_of(kid: KidInfo, today: Optional[dt.date] = None) -> Optional[int]:
    """생일이 있으면 만 나이, 없으면 적어 둔 나이"""
    b = _date(kid.birthday)
    if b is None:
        return kid.age
    today = today or dt.date.today()
    return today.year - b.year - ((today.month, today.day) < (b.month, b.day))


def birthday_days(kid: KidInfo, today: Optional[dt.date] = None) -> Optional[int]:
    """다음 생일까지 며칠 남았는지 (오늘이면 0). 생일을 모르면 None"""
    b = _date(kid.birthday)
    if b is None:
        return None
    today = today or dt.date.today()
    for year in (today.year, today.year + 1):
        try:
            nxt = b.replace(year=year)
        except ValueError:        # 2월 29일생
            nxt = dt.date(year, 3, 1)
        if nxt >= today:
            return (nxt - today).days
    return None


def months_since_start(kid: KidInfo, today: Optional[dt.date] = None) -> Optional[int]:
    s = _date(kid.start_date)
    if s is None:
        return None
    today = today or dt.date.today()
    return max(0, (today.year - s.year) * 12 + today.month - s.month - (today.day < s.day))


def context_lines(kid: KidInfo, today: Optional[dt.date] = None) -> List[str]:
    """시스템 프롬프트에 넣을 '지금 말하는 아이' 정보"""
    today = today or dt.date.today()
    head = f"지금 말하는 아이: {kid.name}"
    nick = (kid.nickname or "").strip()
    if nick and nick != kid.name:
        head += f" (부를 때는 '{nick}')"
    age = age_of(kid, today)
    if age:
        head += f", {age}살"
    lines = [head]
    days = birthday_days(kid, today)
    if days == 0:
        lines.append("오늘이 이 아이 생일이다. 대화 처음에 생일을 축하해 준다.")
    elif days is not None and days <= 7:
        lines.append(f"{days}일 뒤가 이 아이 생일이다. 자연스러우면 한 번쯤 이야기해도 좋다.")
    months = months_since_start(kid, today)
    if months is not None:
        lines.append("이번 달에 학원에 처음 왔다. 낯설 수 있으니 더 반갑게 대한다." if months == 0
                     else f"학원에 다닌 지 {months}달째다.")
    if kid.likes.strip():
        lines.append(f"좋아하는 것: {kid.likes.strip()}")
    if kid.memo.strip():
        lines.append(f"선생님 메모 (아이에게 그대로 말하지 않는다): {kid.memo.strip()}")
    return lines
