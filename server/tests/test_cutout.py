import io

import numpy as np
import pytest

from ribbon.cutout import SIZE, Cutout, CutoutError

PIL = pytest.importorskip("PIL.Image")


class _Input:
    name = "x"


class _FakeSession:
    """가운데 네모만 작품이라고 답하는 가짜 모델"""

    def get_inputs(self):
        return [_Input()]

    def run(self, _names, feeds):
        assert feeds["x"].shape == (1, 3, SIZE, SIZE)
        out = np.full((1, 1, SIZE, SIZE), -8.0, dtype=np.float32)
        out[..., SIZE // 4: SIZE * 3 // 4, SIZE // 4: SIZE * 3 // 4] = 8.0
        return [out]


def _photo(w=200, h=100) -> bytes:
    buf = io.BytesIO()
    PIL.new("RGB", (w, h), (120, 90, 60)).save(buf, "JPEG")
    return buf.getvalue()


def test_status_without_model(tmp_path):
    c = Cutout(tmp_path / "none.onnx", "http://example.invalid/model.onnx")
    assert c.status()["state"] in ("missing", "unavailable")


def test_mask_has_photo_size_and_picks_subject(tmp_path):
    c = Cutout(tmp_path / "m.onnx", "")
    c._session = _FakeSession()
    mask = PIL.open(io.BytesIO(c.mask_png(_photo())))
    assert mask.size == (200, 100) and mask.mode == "L"
    assert mask.getpixel((100, 50)) > 240 and mask.getpixel((5, 5)) < 15


def test_bad_photo_is_reported(tmp_path):
    c = Cutout(tmp_path / "m.onnx", "")
    c._session = _FakeSession()
    with pytest.raises(CutoutError):
        c.mask_png(b"not an image")
