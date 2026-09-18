from ribbon.devices import DeviceBoard


def test_level_only_updates_are_not_changes():
    b = DeviceBoard()
    st = {"running": True, "devices": [{"deviceId": "a", "label": "DJI"}], "levels": [0.1, 0, 0, 0]}
    assert b.update("x/mic", "mic", "mic", "10.0.0.2", st) is True
    assert b.update("x/mic", "mic", "mic", "10.0.0.2", {**st, "levels": [0.5, 0.2, 0, 0]}) is False
    assert b.update("x/mic", "mic", "mic", "10.0.0.2", {**st, "running": False}) is True


def test_snapshot_splits_kinds_and_drop_removes_agent():
    b = DeviceBoard()
    b.update("x/mic", "mic", "mic", "h", {"running": False})
    b.update("x/tv", "output", "tv", "h", {"current": ""})
    b.update("x/tv", "mic", "tv", "h", {"running": True})     # TV 에서 마이크도 받는 경우
    snap = b.snapshot()
    assert [d["agent"] for d in snap["mics"]] == ["x/mic", "x/tv"]
    assert [d["agent"] for d in snap["outputs"]] == ["x/tv"]
    assert b.drop_agent("x/tv") is True
    assert b.snapshot()["outputs"] == [] and len(b.snapshot()["mics"]) == 1


def test_unknown_kind_is_ignored():
    b = DeviceBoard()
    assert b.update("x/mic", "camera", "mic", "h", {}) is False
    assert b.snapshot()["mics"] == []
