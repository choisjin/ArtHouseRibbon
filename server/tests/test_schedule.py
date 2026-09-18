import datetime as dt

import pytest

from ribbon import schedule as sched
from ribbon.protocol import ClassSlot, KidInfo

MON = dt.date(2026, 9, 21)      # 월요일
WED = MON + dt.timedelta(days=2)
FRI = MON + dt.timedelta(days=4)


def kid(kid_id="k1", *slots):
    return KidInfo(id=kid_id, name=kid_id, schedule=[ClassSlot(day=d, start=s, end=e) for d, s, e in slots])


def test_weekly_slots_repeat_every_week():
    k = kid("k1", (0, "15:00", "16:30"), (2, "17:00", "18:30"))
    items = sched.occurrences([k], [], MON, MON + dt.timedelta(days=13))
    assert [(o.date, o.start, o.end) for o in items] == [
        ("2026-09-21", "15:00", "16:30"), ("2026-09-23", "17:00", "18:30"),
        ("2026-09-28", "15:00", "16:30"), ("2026-09-30", "17:00", "18:30"),
    ]


def test_move_changes_only_that_day_and_keeps_length():
    k = kid("k1", (0, "15:00", "16:30"))
    ov = []
    sched.move(ov, k, "2026-09-21", "15:00", "2026-09-23", "16:00")
    items = sched.occurrences([k], ov, MON, MON + dt.timedelta(days=7))
    assert [(o.date, o.start, o.end, o.moved) for o in items] == [
        ("2026-09-23", "16:00", "17:30", True),
        ("2026-09-28", "15:00", "16:30", False),     # 다음 주는 그대로
    ]


def test_moved_into_range_from_outside_is_shown():
    k = kid("k1", (0, "15:00", "16:30"))
    ov = []
    sched.move(ov, k, "2026-09-21", "15:00", "2026-09-25", "15:00")   # 월 → 금
    items = sched.occurrences([k], ov, FRI, FRI)
    assert [(o.date, o.orig_date) for o in items] == [("2026-09-25", "2026-09-21")]


def test_moving_again_replaces_and_back_to_origin_restores():
    k = kid("k1", (0, "15:00", "16:30"))
    ov = []
    sched.move(ov, k, "2026-09-21", "15:00", "2026-09-22", "15:00")
    sched.move(ov, k, "2026-09-21", "15:00", "2026-09-23", "15:00")
    assert len(ov) == 1 and ov[0].date == "2026-09-23"
    sched.move(ov, k, "2026-09-21", "15:00", "2026-09-21", "15:00")
    assert ov == []


def test_cancel_and_restore():
    k = kid("k1", (0, "15:00", "16:30"))
    ov = []
    sched.cancel(ov, k, "2026-09-21", "15:00")
    assert sched.occurrences([k], ov, MON, MON) == []
    shown = sched.occurrences([k], ov, MON, MON, include_cancelled=True)
    assert len(shown) == 1 and shown[0].cancelled
    assert sched.restore(ov, "k1", "2026-09-21", "15:00")
    assert len(sched.occurrences([k], ov, MON, MON)) == 1


def test_move_rejects_non_regular_class():
    k = kid("k1", (0, "15:00", "16:30"))
    with pytest.raises(ValueError):
        sched.move([], k, "2026-09-22", "15:00", "2026-09-23", "15:00")   # 화요일엔 수업 없음


def test_current_includes_class_starting_within_30_minutes():
    k1 = kid("k1", (0, "15:00", "16:30"))
    k2 = kid("k2", (0, "17:00", "18:30"))
    store = sched.ScheduleStore.__new__(sched.ScheduleStore)
    store.overrides = []
    now = dt.datetime(2026, 9, 21, 16, 40)
    assert [o.kid_id for o in store.current([k1, k2], now)] == ["k2"]
    now = dt.datetime(2026, 9, 21, 16, 0)
    assert [o.kid_id for o in store.current([k1, k2], now)] == ["k1"]
