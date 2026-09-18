from ribbon.devices import DeviceBoard


def test_same_status_is_not_a_change():
    b = DeviceBoard()
    st = {"current": "", "devices": [{"deviceId": "a", "label": "HDMI"}], "locked": True}
    assert b.update("x/tv", "output", "tv", "10.0.0.2", st) is True
    assert b.update("x/tv", "output", "tv", "10.0.0.2", dict(st)) is False
    assert b.update("x/tv", "output", "tv", "10.0.0.2", {**st, "current": "a"}) is True


def test_snapshot_and_drop():
    b = DeviceBoard()
    b.update("x/tv", "output", "tv", "h", {"current": ""})
    b.update("y/tv", "output", "tv", "h2", {"current": ""})
    assert [d["agent"] for d in b.snapshot()["outputs"]] == ["x/tv", "y/tv"]
    assert b.drop_agent("x/tv") is True
    assert [d["agent"] for d in b.snapshot()["outputs"]] == ["y/tv"]
    assert b.drop_agent("x/tv") is False


def test_unknown_kind_is_ignored():
    b = DeviceBoard()
    assert b.update("x/mic", "mic", "mic", "h", {}) is False
    assert b.snapshot()["outputs"] == []
