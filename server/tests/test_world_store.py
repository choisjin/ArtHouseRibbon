import base64
import json

import pytest

from ribbon.world_store import WorldStore

CATALOG = {
    "rooms": {"classroom": {"name": "미술실"}, "gallery": {"name": "전시장"}},
    "types": [],
    "default_layouts": {
        "classroom": {"doll_spot": {"x": 1, "y": 2}, "items": [{"id": "t", "type": "table", "x": 0, "y": 0, "rot": 0}]},
        "gallery": {"doll_spot": {"x": 0, "y": 0}, "items": []},
    },
}
PNG_1PX = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082")).decode()


@pytest.fixture
def store(tmp_path):
    cat = tmp_path / "catalog.json"
    cat.write_text(json.dumps(CATALOG), encoding="utf-8")
    return WorldStore(cat, tmp_path / "world", tmp_path / "artworks")


def test_default_layout_and_active(store):
    assert store.active == "classroom"
    assert store.layout("classroom")["items"][0]["id"] == "t"
    assert not store.has_layout("classroom")
    store.set_active("gallery")
    assert store.tv_view()["room"] == "gallery"
    with pytest.raises(ValueError):
        store.set_active("nowhere")


def test_save_validates_and_keeps_history(store):
    lay = {"items": [{"id": "a", "type": "table", "x": "1.5", "y": 0, "rot": 90}], "arts": []}
    store.save_layout("classroom", lay)
    assert store.layout("classroom")["items"][0]["x"] == 1.5
    store.save_layout("classroom", lay)
    assert len(list((store.dir / "history").glob("classroom_*.json"))) == 1
    with pytest.raises(ValueError):
        store.save_layout("classroom", {"items": [{"id": "a"}]})
    with pytest.raises(ValueError):
        store.save_layout("classroom", {"items": [], "arts": [
            {"id": "x", "image": "artworks/../../secret.png", "width": 1, "aspect": 1, "mount": {}}]})
    store.reset_layout("classroom")
    assert store.layout("classroom")["items"][0]["id"] == "t"


def test_artwork_upload_usage_and_delete(store):
    body = {"name": "그림.png", "data": f"data:image/png;base64,{PNG_1PX}", "width": 1, "height": 1}
    entry, new = store.add_artwork(body)
    assert new and entry["file"].startswith("artworks/") and entry["name"] == "그림"
    assert store.add_artwork(body) == (entry, False)
    store.save_layout("gallery", {"items": [], "arts": [
        {"id": "art_1", "image": entry["file"], "width": 1, "aspect": 1, "mount": {"host": None, "id": "wall"}}]})
    with pytest.raises(ValueError):
        store.delete_artwork(entry["file"])
    store.save_layout("gallery", {"items": [], "arts": []})
    store.delete_artwork(entry["file"])
    assert store.artworks() == []
    with pytest.raises(ValueError):
        store.add_artwork({"data": "data:text/plain;base64,AAAA", "width": 1, "height": 1})


def test_renderer_info_and_stale(store, tmp_path):
    import asyncio

    from ribbon.world_render import WorldRenderer

    r = WorldRenderer(store, blender=str(tmp_path / "no-blender"))
    store.render_info = r.info
    assert r.info("classroom") is None
    assert store.tv_view()["render"] is None
    lay = store.layout("classroom")
    r.dir.mkdir(parents=True)
    (r.dir / "classroom.png").write_bytes(b"png")
    (r.dir / "classroom.json").write_text(json.dumps({"layout": lay, "rendered_at": 5}), encoding="utf-8")
    info = store.tv_view()["render"]
    assert info["bg"] == "/world-render/classroom.png?v=5" and info["env"] is None and not info["stale"]
    store.save_layout("classroom", {"items": [], "arts": []})
    assert r.info("classroom")["stale"]
    if r.blender is None:   # 블렌더가 없으면 요청을 받지 않는다
        assert asyncio.run(_request(r)) is False


async def _request(r):
    return r.request("classroom")
