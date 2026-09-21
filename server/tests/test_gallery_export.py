import base64
import json
import re
import types

import pytest

from ribbon import gallery_export

PNG_1PX = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082")).decode()


class FakeWorld:
    """world_store 대신 쓸 최소한의 흉내 (내보내기가 무엇을 읽는지 한눈에 보인다)"""

    def __init__(self, tmp_path, render_dir):
        self.art_dir = tmp_path / "artworks"
        self.art_dir.mkdir(parents=True)
        (self.art_dir / "a.png").write_bytes(base64.b64decode(PNG_1PX))
        (self.art_dir / "b.png").write_bytes(base64.b64decode(PNG_1PX))
        (render_dir / "kidbase_day_pano.jpg").write_bytes(b"jpegjpeg")
        self.catalog = {"rooms": {"gallery": {
            "unit_per_m": 2.0, "front_y": -8.0, "back_y": 8.0,
            "mounts": [{"id": "back", "name": "뒤쪽 벽", "origin": [0, 8, 0], "normal": [0, -1, 0], "up": [0, 0, 1],
                        "width": 18.0, "height": 10.0},
                       {"id": "easel", "name": "이젤", "origin": [0, 0, 0], "normal": [0, -1, 0], "up": [0, 0, 1],
                        "width": 1.0, "height": 1.0, "ledge": True}]}}}

    @staticmethod
    def shell_room(_room):
        return "gallery"

    @staticmethod
    def kid_room(kid_id, hall=1):
        return f"kid-{kid_id}" if hall <= 1 else f"kid-{kid_id}@{hall}"

    @staticmethod
    def kid_rooms(kid_id):
        return [f"kid-{kid_id}", f"kid-{kid_id}@2"]

    @staticmethod
    def layout(room):
        art = {"id": "x", "image": "artworks/a.png", "width": 1.0, "aspect": 0.75, "frame": "wood",
               "mount": {"host": None, "id": "back"}, "u": 0.2, "v": 1.6, "bg": "#ffffff", "pad": [0, 0, 0, 0],
               "fx": {"s": 1.2, "glow": 1.0}, "pin": True}
        return {"light": 0.8, "arts": [art] if room.endswith("k1") else []}

    @staticmethod
    def render_info(_room):
        return {"pano": "/world-render/kidbase_day_pano.jpg?v=7"}

    @staticmethod
    def artworks(_kid_id):
        return [{"file": "artworks/a.png", "name": "노을", "made": "2026-09-14", "note": "노을을 그렸어요",
                 "bg": "#ffffff", "pad": [0, 0, 0, 0], "width": 600, "height": 450, "size": 1.0, "frame": "wood"},
                {"file": "artworks/b.png", "name": "바다", "made": "", "note": "", "bg": "#ffffff",
                 "pad": [0, 0, 0, 0], "width": 600, "height": 450, "size": 1.0, "frame": "white"}]


def _data(html):
    """HTML 에 박아 넣은 window.__GALLERY__ 를 꺼낸다"""
    m = re.search(r"window\.__GALLERY__ = (\{.*?\});</script>", html, re.S)
    assert m
    return json.loads(m.group(1).replace("\u003c", "<"))


@pytest.fixture
def world(tmp_path):
    render = tmp_path / "render"
    render.mkdir()
    return FakeWorld(tmp_path, render), render


def test_export_is_one_file_with_everything_inside(world):
    w, render = world
    kid = types.SimpleNamespace(id="k1", name="지우")
    name, html = gallery_export.build(w, kid, "console.log('viewer')", render)
    assert name == "지우_전시실.html" and "console.log('viewer')" in html
    raw = re.search(r"window\.__GALLERY__ = (\{.*?\});</script>", html, re.S).group(1)
    assert "<" not in raw                              # 값 안의 < 는 < 로 막는다 (</script> 로 끊기지 않게)
    assert "http://" not in html and "/api/" not in html   # 서버를 부르지 않는다

    data = _data(html)
    assert data["kid"] == "지우" and len(data["halls"]) == 2
    assert data["halls"][0]["arts"][0]["image"] == "artworks/a.png" and data["halls"][1]["arts"] == []
    assert data["halls"][0]["light"] == 0.8
    assert data["halls"][0]["pano"].startswith("data:image/jpeg;base64,")
    assert [a["name"] for a in data["artworks"]] == ["노을", "바다"]      # 걸지 않은 것까지
    assert data["artworks"][0]["note"] == "노을을 그렸어요"
    assert all(v.startswith("data:image/png;base64,") for v in data["images"].values())
    assert [m["id"] for m in data["room"]["mounts"]] == ["back"]        # 받침대(이젤)는 뺀다


def test_export_keeps_going_when_a_picture_is_missing(world, caplog):
    w, render = world
    (w.art_dir / "b.png").unlink()
    kid = types.SimpleNamespace(id="k1", name="지우")
    _, html = gallery_export.build(w, kid, "", render)
    data = _data(html)
    assert [a["name"] for a in data["artworks"]] == ["노을"]            # 못 읽은 것은 빼고 나머지는 담는다
    assert "artworks/a.png" in data["images"]
