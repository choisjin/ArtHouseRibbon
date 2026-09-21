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

    # 가운데 실 하나만 없애면 뒤 실이 한 칸씩 당겨진다
    store.save_layout("kid-k1@2", {"items": [], "arts": [], "light": 0.8})
    assert store.remove_hall("k1", 2) == 2
    assert store.halls("k1") == 2 and store.layout("kid-k1@2")["arts"][0]["id"] == "x"   # 3실이 2실로
    assert store.art_usage(art["file"]) == ["kid-k1@2"]
    with pytest.raises(ValueError):
        store.remove_hall("k1", 5)

    store.set_active("kid-k1@2")
    assert store.set_halls("k1", 1) == 1                    # 줄이면 뒤쪽 실은 사라진다
    assert not store.layout_path("kid-k1@2").exists() and store.active == "kid-k1"
    with pytest.raises(ValueError):
        store.remove_hall("k1", 1)                          # 하나 남은 전시실은 못 없앤다
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
    assert art["bg"] == "#ffffff" and art["pad"] == [0, 0, 0, 0] and art["frame"] == "white"   # 정하지 않으면 흰 배경·흰 액자
    assert art["made"] == "" and art["note"] == "" and art["size"] == 0.8
    assert art["fx"] == {"b": 0, "c": 0, "s": 1, "w": 0, "sepia": 0}     # 필터도 걸지 않은 상태
    hung = {"id": "x", "image": art["file"], "width": 1, "aspect": 0.5, "mount": {"host": None, "id": "back"}}
    store.save_layout("kid-k1", {"items": [], "arts": [hung]})
    store.save_layout("kid-k1@2", {"items": [], "arts": [{**hung, "id": "y"}]})

    entry, rooms = store.update_artwork(art["file"], {"bg": "#FBDCE4", "pad": [0.1, 0.2, 0.1, 9], "frame": "gold",
                                                     "name": " 봄 소풍 ", "made": "2026-09-14", "note": "벚꽃을 그렸어요"})
    assert entry["bg"] == "#fbdce4" and entry["pad"] == [0.1, 0.2, 0.1, 0.4] and rooms == ["kid-k1", "kid-k1@2"]
    assert entry["frame"] == "gold" and entry["name"] == "봄 소풍" and entry["made"] == "2026-09-14"
    assert store.update_artwork(art["file"], {"made": "어제", "frame": "없는액자"})[0] == {**entry, "made": "", "frame": "white"}
    store.update_artwork(art["file"], {"frame": "gold", "made": "2026-09-14"})
    # 크기와 필터도 작품에 붙는다. 걸린 그림의 하이라이트(glow*)는 그대로 두고 필터만 덮어쓴다
    store.save_layout("kid-k1@2", {"items": [], "arts": [{**hung, "id": "y", "fx": {"glow": 1.2, "s": 0.2}}]})
    store.update_artwork(art["file"], {"size": 5, "fx": {"s": 1.4, "sepia": 0.5}})
    got = store.layout("kid-k1@2")["arts"][0]
    assert got["width"] == 3.0 and got["fx"]["glow"] == 1.2 and got["fx"]["s"] == 1.4 and got["fx"]["sepia"] == 0.5
    assert got["bg"] == "#fbdce4" and got["pad"] == [0.1, 0.2, 0.1, 0.4] and got["frame"] == "gold"
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


def test_gallery_holds_artworks_only(store):
    """전시장(과 아이 전시실)에는 가구를 두지 않는다: 저장해도 가구는 버리고 작품과 조명 밝기만 남긴다"""
    art, _ = store.add_artwork({"name": "a", "data": "data:image/png;base64," + PNG_1PX, "width": 1, "height": 1})
    wall = {"id": "x", "image": art["file"], "width": 1, "aspect": 1, "mount": {"host": None, "id": "back"}}
    easel = {**wall, "id": "y", "mount": {"host": "easel_1", "id": "canvas"}}
    store.save_layout("gallery", {"items": [{"id": "bench", "type": "bench", "x": 0, "y": 0, "rot": 0}],
                                  "arts": [wall, easel], "light": 0.4})
    lay = store.layout("gallery")
    assert lay["items"] == [] and [a["id"] for a in lay["arts"]] == ["x"] and lay["light"] == 0.4
    assert store.live_arts("gallery") and not store.live_arts("classroom")
    assert store.layout("kidbase")["items"] == [] and "light" not in store.layout("kidbase")
    # 미술실은 그대로 가구를 둔다
    store.save_layout("classroom", {"items": [{"id": "t", "type": "table", "x": 0, "y": 0, "rot": 0}], "arts": []})
    assert len(store.layout("classroom")["items"]) == 1


def test_characters_come_from_the_world_folder(store, tmp_path):
    """캐릭터는 client/public/world/<id>.glb 를 세어서 알려 준다 (아이마다 만들어 넣으면 바로 늘어난다)"""
    folder = store.catalog_path.parent
    for name in ("ollie.glb", "seoyul.glb", "jiwoo.glb", "room_shell.glb", "room_shell_gallery.glb"):
        (folder / name).write_bytes(b"glb")
    (folder / "characters.json").write_text(json.dumps({"seoyul": "서율 (여자)"}), encoding="utf-8")
    got = store.characters()
    assert [c["id"] for c in got] == ["jiwoo", "ollie", "seoyul"]      # 방 껍데기는 빼고
    assert [c["name"] for c in got] == ["jiwoo", "ollie", "서율 (여자)"]   # 이름을 안 적으면 파일 이름


def test_renderer_info_and_stale(store, tmp_path):
    import asyncio

    from ribbon.world_render import WorldRenderer

    r = WorldRenderer(store, blender=str(tmp_path / "no-blender"))
    store.render_info = r.info
    assert r.info("classroom") is None
    assert store.tv_view()["render"] is None
    lay = store.layout("classroom")
    r.dir.mkdir(parents=True)
    (r.dir / "classroom_day.png").write_bytes(b"png")           # 시간대별로 한 장씩 (여기서는 낮 한 장만 있다)
    (r.dir / "classroom.json").write_text(json.dumps({"layout": lay, "rendered_at": 5}), encoding="utf-8")
    info = store.tv_view()["render"]
    assert info["bg"] == "/world-render/classroom_day.png?v=5" and info["env"] is None and not info["stale"]
    assert info["pano"] is None                                  # 둘러보기 파노라마는 전시장 껍데기만
    store.save_layout("classroom", {"items": [], "arts": []})
    assert r.info("classroom")["stale"]

    # 전시장: 렌더 방식 판(SHELL_VERSION)이 옛것이면 다시 굽는다. 파노라마는 찍은 자리가 적혀 있어야 쓴다
    from ribbon.world_render import SHELL_VERSION
    store._catalog["rooms"]["gallery"].update(front_y=-8.0, back_y=8.0, unit_per_m=2.0)
    pos = r.pano_pos("gallery")
    assert pos == [0.0, pytest.approx(-0.18 * 16), pytest.approx(1.9 * 2.0)] and r.pano_pos("classroom") is None
    # 전시장과 아이 전시실은 빈 전시실 배경(kidbase) 한 벌을 같이 쓰고, 걸린 그림은 TV 가 실시간으로 그린다
    assert "gallery" not in store.render_rooms() and "kidbase" in store.render_rooms()
    assert r.info("gallery") is None
    base = store.layout("kidbase")
    (r.dir / "kidbase_day.png").write_bytes(b"png")
    (r.dir / "kidbase_day_pano.jpg").write_bytes(b"jpg")
    (r.dir / "kidbase.json").write_text(json.dumps({"layout": base, "rendered_at": 7}), encoding="utf-8")
    old = r.info("kidbase")
    assert old["stale"] and old["pano"] is None                  # 판도 자리도 없는 옛 렌더
    (r.dir / "kidbase.json").write_text(json.dumps({"layout": base, "rendered_at": 7, "pano_pos": pos,
                                                    "version": SHELL_VERSION["gallery"]}), encoding="utf-8")
    new = r.info("kidbase")
    assert not new["stale"] and new["pano"] == "/world-render/kidbase_day_pano.jpg?v=7" and new["pano_pos"] == pos
    gal = r.info("gallery")
    assert gal["bg"] == new["bg"] and gal["arts_live"] and gal["layout"]["items"] == [] and not gal["stale"]
    if r.blender is None:   # 블렌더가 없으면 요청을 받지 않는다
        assert asyncio.run(_request(r)) is False


async def _request(r):
    return r.request("classroom")
