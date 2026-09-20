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


def test_kid_gallery_halls_light_and_share(store):
    """아이 전시실: 1실·2실… 로 늘리고, 실마다 조명을 따로 두고, 부모님께 보낼 열쇠를 만든다"""
    store.kid_ids = lambda: ["k1"]
    assert store.kid_room("k1") == "kid-k1" and store.kid_room("k1", 2) == "kid-k1@2"
    assert store.kid_of("kid-k1@2") == "k1" and store.hall_of("kid-k1@2") == 2 and store.hall_of("kid-k1") == 1
    assert store.kid_rooms("k1") == ["kid-k1"]
    with pytest.raises(ValueError):
        store.check_room("kid-k1@2")             # 아직 없는 실

    assert store.set_halls("k1", 3) == 3
    assert store.kid_rooms("k1") == ["kid-k1", "kid-k1@2", "kid-k1@3"]
    art, _ = store.add_artwork({"name": "a", "data": "data:image/png;base64," + PNG_1PX, "width": 1, "height": 1, "kid_id": "k1"})
    hung = {"id": "x", "image": art["file"], "width": 1, "aspect": 1, "mount": {"host": None, "id": "back"}}
    store.save_layout("kid-k1@3", {"items": [], "arts": [hung], "light": 0.5})
    store.save_layout("kid-k1", {"items": [], "arts": [], "light": 9})
    lay = store.layout("kid-k1@3")
    assert lay["light"] == 0.5 and lay["hall"] == 3 and lay["halls"] == 3 and lay["shell"] == "gallery"
    assert store.layout("kid-k1")["light"] == 1.6           # 너무 밝은 값은 한계로
    assert store.halls("k1") == 3                           # 1실을 저장해도 전시실 수는 그대로
    assert store.art_usage(art["file"]) == ["kid-k1@3"]     # 2실·3실에 걸린 것도 센다

    store.set_active("kid-k1@3")
    assert store.set_halls("k1", 1) == 1                    # 줄이면 뒤쪽 실은 사라진다
    assert not store.layout_path("kid-k1@3").exists() and store.active == "kid-k1"
    assert store.art_usage(art["file"]) == []

    token = store.share_token("k1")
    assert token == store.share_token("k1") and len(token) >= 12
    assert store.shared_kid(token) == "k1" and store.shared_kid("nope") is None
    store.kid_ids = lambda: []
    assert store.shared_kid(token) is None                  # 아이가 지워지면 주소도 죽는다


def test_artwork_look_is_synced_to_hung_arts(store):
    """작품의 배경색·여백을 바꾸면 걸려 있는 곳(모든 실)의 모습과 비율도 같이 바뀐다. 새 그림으로 갈아 끼우기도 마찬가지"""
    store.kid_ids = lambda: ["k1"]
    store.set_halls("k1", 2)
    up = {"name": "a", "data": "data:image/png;base64," + PNG_1PX, "width": 200, "height": 100, "kid_id": "k1"}
    art, _ = store.add_artwork(up)
    assert art["bg"] == "#ffffff" and art["pad"] == [0, 0, 0, 0]          # 정하지 않으면 흰 배경
    hung = {"id": "x", "image": art["file"], "width": 1, "aspect": 0.5, "mount": {"host": None, "id": "back"}}
    store.save_layout("kid-k1", {"items": [], "arts": [hung]})
    store.save_layout("kid-k1@2", {"items": [], "arts": [{**hung, "id": "y"}]})

    entry, rooms = store.update_artwork(art["file"], {"bg": "#FBDCE4", "pad": [0.1, 0.2, 0.1, 9]})
    assert entry["bg"] == "#fbdce4" and entry["pad"] == [0.1, 0.2, 0.1, 0.4] and rooms == ["kid-k1", "kid-k1@2"]
    got = store.layout("kid-k1@2")["arts"][0]
    assert got["bg"] == "#fbdce4" and got["pad"] == [0.1, 0.2, 0.1, 0.4]
    assert got["aspect"] == pytest.approx((100 + 0.6 * 200) / (200 + 0.2 * 200), rel=1e-4)
    assert store.update_artwork(art["file"], {"bg": "red"})[0]["bg"] == "#ffffff"   # 이상한 색은 흰색으로
    with pytest.raises(ValueError):
        store.update_artwork("artworks/none.png", {})

    other = base64.b64encode(base64.b64decode(PNG_1PX) + b"x").decode()  # 내용이 다른 새 파일
    new, _ = store.add_artwork({**up, "data": "data:image/png;base64," + other, "width": 100, "height": 100, "bg": "#222222"})
    assert store.replace_artwork(art["file"], new["file"]) == ["kid-k1", "kid-k1@2"]
    got = store.layout("kid-k1")["arts"][0]
    assert got["image"] == new["file"] and got["bg"] == "#222222" and got["aspect"] == 1
    assert [a["file"] for a in store.artworks("k1")] == [new["file"]]    # 옛 그림은 지워진다


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
