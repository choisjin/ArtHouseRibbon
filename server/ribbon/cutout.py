"""작품 사진 배경 지우기 (전시실 꾸미기 ?mode=art 의 '배경 지우기').

색이 비슷한 곳을 가장자리부터 지우던 방식은 책상 무늬·그림자·흰 종이에 약했다. 그래서 사진에서 **주인공을 골라내는
모델**(BiRefNet lite, ONNX)을 서버에서 돌린다. onnxruntime 은 Supertonic TTS 때문에 이미 깔려 있고, 사진을 읽는 데
Pillow 만 더 쓴다. 모델 파일(약 220MB)은 처음 쓸 때 data/models/ 로 내려받는다.

서버는 **마스크(흑백 PNG)** 만 돌려준다. 자르고 투명하게 만드는 것은 브라우저가 원본 크기로 한다.
"""
from __future__ import annotations

import io
import logging
import threading
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np

log = logging.getLogger("ribbon.cutout")

SIZE = 1024                                   # 모델 입력 (정사각형)
_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


class CutoutError(RuntimeError):
    pass


class Cutout:
    def __init__(self, model_path: Path, model_url: str):
        self.model_path = model_path
        self.model_url = model_url
        self._session: Any = None
        self._lock = threading.Lock()          # 모델은 한 번에 한 장씩
        self._fetch: Optional[threading.Thread] = None
        self.progress = 0.0                    # 내려받는 중이면 0~1
        self.error = ""

    # ---------- 준비 ----------
    @staticmethod
    def missing() -> str:
        """못 쓰는 까닭 (쓸 수 있으면 빈 문자열)"""
        for mod, pip in (("onnxruntime", "onnxruntime"), ("PIL", "pillow")):
            try:
                __import__(mod)
            except ImportError:
                return f"서버에 {pip} 가 없습니다 (pip install {pip})"
        return ""

    def status(self) -> Dict[str, Any]:
        miss = self.missing()
        if miss:
            return {"state": "unavailable", "detail": miss}
        if self.model_path.exists():
            return {"state": "ready"}
        if self._fetch and self._fetch.is_alive():
            return {"state": "downloading", "progress": round(self.progress, 3)}
        return {"state": "missing", "detail": self.error}

    def start_download(self) -> None:
        """모델을 뒤에서 내려받는다 (이미 받는 중이면 그대로)"""
        if self.model_path.exists() or (self._fetch and self._fetch.is_alive()):
            return
        self.error = ""
        self.progress = 0.0
        self._fetch = threading.Thread(target=self._download, name="cutout-model", daemon=True)
        self._fetch.start()

    def _download(self) -> None:
        import httpx
        tmp = self.model_path.with_suffix(".part")
        try:
            self.model_path.parent.mkdir(parents=True, exist_ok=True)
            with httpx.stream("GET", self.model_url, follow_redirects=True, timeout=60) as res:
                res.raise_for_status()
                total = int(res.headers.get("content-length") or 0)
                got = 0
                with tmp.open("wb") as f:
                    for chunk in res.iter_bytes(1 << 20):
                        f.write(chunk)
                        got += len(chunk)
                        if total:
                            self.progress = got / total
            tmp.replace(self.model_path)
            log.info("배경 지우기 모델을 받았습니다: %s", self.model_path)
        except Exception as e:                  # noqa: BLE001 - 어떤 까닭이든 화면에 알려 준다
            self.error = f"모델을 받지 못했습니다: {e}"
            log.exception("배경 지우기 모델 내려받기 실패")
            tmp.unlink(missing_ok=True)

    # ---------- 마스크 ----------
    def mask_png(self, image: bytes) -> bytes:
        """사진(JPEG/PNG 바이트) -> 같은 크기의 흑백 마스크 PNG (흰 곳이 작품)"""
        from PIL import Image
        try:
            img = Image.open(io.BytesIO(image))
            img.load()
        except Exception as e:                  # noqa: BLE001
            raise CutoutError("사진을 읽지 못했습니다") from e
        rgb = img.convert("RGB")
        x = np.asarray(rgb.resize((SIZE, SIZE), Image.BILINEAR), dtype=np.float32) / 255.0
        x = ((x - _MEAN) / _STD).transpose(2, 0, 1)[None]
        with self._lock:
            sess = self._load()
            out = sess.run(None, {sess.get_inputs()[0].name: x})[-1]
        m = 1.0 / (1.0 + np.exp(-out.reshape(SIZE, SIZE).astype(np.float32)))
        lo, hi = float(m.min()), float(m.max())
        if hi - lo > 1e-6:
            m = (m - lo) / (hi - lo)
        mask = Image.fromarray((m * 255).astype(np.uint8), "L").resize(rgb.size, Image.BILINEAR)
        buf = io.BytesIO()
        mask.save(buf, "PNG", optimize=True)
        return buf.getvalue()

    def _load(self) -> Any:
        if self._session is None:
            import onnxruntime as ort
            opts = ort.SessionOptions()
            opts.log_severity_level = 3
            self._session = ort.InferenceSession(str(self.model_path), opts, providers=["CPUExecutionProvider"])
            log.info("배경 지우기 모델을 읽었습니다: %s", self.model_path.name)
        return self._session
