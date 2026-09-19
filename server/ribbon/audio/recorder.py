"""인식 개선용 녹음 저장 (관리자 캐릭터 탭 "아이 말 녹음 저장"을 켰을 때만).

data/recordings/<날짜>/<시각>_ch<n>.wav 와 같은 폴더의 index.jsonl (들은 글자, 인식 힌트, 아이, 길이).
인식이 빈 말(잡음·환각으로 버린 것)도 남겨서 무엇을 놓쳤는지 볼 수 있다.
tools/stt_eval.py 가 이 녹음으로 여러 인식 모델을 비교한다.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import wave
from pathlib import Path
from typing import Optional

import numpy as np

log = logging.getLogger("ribbon.recorder")


def save(root: Path, pcm: np.ndarray, sample_rate: int, channel: int, text: str, prompt: str,
         kid_id: Optional[str]) -> Optional[Path]:
    now = dt.datetime.now()
    folder = root / now.strftime("%Y-%m-%d")
    try:
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{now.strftime('%H%M%S_%f')[:10]}_ch{channel + 1}.wav"
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(np.asarray(pcm, dtype=np.int16).tobytes())
        rec = {"file": path.name, "time": now.isoformat(timespec="seconds"), "channel": channel + 1,
               "kid": kid_id, "seconds": round(len(pcm) / sample_rate, 2), "heard": text, "prompt": prompt,
               "correct": ""}   # correct: 실제로 한 말을 적어 두면 stt_eval 이 정확도를 잰다
        with open(folder / "index.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return path
    except OSError:
        log.exception("녹음 저장 실패")
        return None
