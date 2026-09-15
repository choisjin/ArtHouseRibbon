from ribbon.queue import TurnQueue


def test_first_request_is_active_immediately():
    q = TurnQueue()
    turn, pos, created = q.request("a", 0, now=0)
    assert created and pos == 0 and turn.state == "active"
    assert q.active() is turn


def test_second_request_waits_in_order():
    q = TurnQueue()
    q.request("a", 0, now=0)
    t2, pos2, _ = q.request("b", 1, now=1)
    t3, pos3, _ = q.request("c", 2, now=2)
    assert pos2 == 1 and pos3 == 2
    assert [t.kid_id for t in q.waiting()] == ["b", "c"]


def test_duplicate_request_same_channel_not_created():
    q = TurnQueue()
    t1, _, _ = q.request("a", 0, now=0)
    t1b, pos, created = q.request("a", 0, now=1)
    assert t1b is t1 and not created and pos == 0


def test_waiting_turn_collects_text():
    q = TurnQueue()
    q.request("a", 0, now=0)
    q.request("b", 1, now=1)
    q.add_text(1, "내 그림 봐줘", now=2)
    q.add_text(1, "고양이야", now=3)
    assert q.waiting()[0].text == "내 그림 봐줘 고양이야"


def test_complete_promotes_next_with_text_preserved():
    q = TurnQueue()
    q.request("a", 0, now=0)
    q.request("b", 1, now=1)
    q.add_text(1, "질문", now=2)
    nxt = q.complete_active(now=5)
    assert nxt is not None and nxt.kid_id == "b" and nxt.state == "active" and nxt.text == "질문"
    assert q.complete_active(now=6) is None
    assert len(q) == 0


def test_cancel_waiting_and_active():
    q = TurnQueue()
    q.request("a", 0, now=0)
    q.request("b", 1, now=1)
    q.request("c", 2, now=2)
    assert q.cancel(1).kid_id == "b"
    assert [t.kid_id for t in q.waiting()] == ["c"]
    assert q.cancel(0).kid_id == "a"
    assert q.active().kid_id == "c"
    assert q.cancel(3) is None


def test_expire_waiting_without_text():
    q = TurnQueue()
    q.request("a", 0, now=0)
    q.request("b", 1, now=1)
    q.request("c", 2, now=2)
    q.add_text(2, "나 할 말 있어", now=3)
    expired = q.expire(now=30, waiting_timeout=20)
    assert [t.kid_id for t in expired] == ["b"]
    assert [t.kid_id for t in q.waiting()] == ["c"]
    assert q.active().kid_id == "a"  # 활성 턴은 만료 대상이 아님
