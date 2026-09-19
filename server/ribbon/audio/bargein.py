"""끼어들기 (barge-in): 리본이가 말하는 중에 아이가 말하면 리본이가 멈추고 그 말을 받는다 (2026-09-20).

에코 막기는 리본이가 말하는 동안 마이크 소리를 버린다 (TV 스피커 소리가 다시 들어와 새 질문이 되지 않게).
그래서 리본이 말이 끝나기 전에 아이가 말하면 앞부분이 잘리거나 통째로 없어졌다.
목에 거는 무선 마이크(DJI)는 입 가까이 있어서 아이 목소리가 스피커 소리보다 훨씬 크게 들어온다.
리본이가 말하는 동안 채널마다 최근 0.5초를 기억해 두고, 기준보다 큰 소리가 0.3초 이어지면 끼어든 것으로 본다.
기준(threshold)은 방·스피커마다 달라서, 리본이가 한 번 말할 때마다 채널별로 들어온 가장 큰 소리(= 에코 크기)를
알려 준다 (main 이 로그에 남긴다). 기준은 그보다 넉넉히 크게.
"""
from __future__ import annotations

from collections import deque
from typing import Deque, List, Optional

import numpy as np

FRAME_S = 0.02


class BargeIn:
    def __init__(self, keep_s: float = 0.5, need_s: float = 0.3):
        # 기억은 끼어든 소리(0.3초) + 그 앞 조금만: 더 길면 리본이 목소리까지 아이 말에 섞여 인식된다
        self.buf: Deque[np.ndarray] = deque(maxlen=int(keep_s / FRAME_S))
        self.need = int(need_s / FRAME_S)
        self.run = 0
        self._loud = 0.0
        self.peak = 0.0                      # 이번에 리본이가 말하는 동안 들어온 가장 큰 소리 (에코 크기)

    def feed(self, pcm: np.ndarray, threshold: float) -> Optional[List[np.ndarray]]:
        """리본이가 말하는 동안의 소리 한 조각. 끼어들었으면 기억해 둔 소리(말 앞부분 포함)를 돌려준다"""
        self.buf.append(pcm)
        x = pcm.astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(x * x))) if x.size else 0.0
        if rms > threshold:
            self.run += 1
            self._loud = max(self._loud, rms)    # 끼어들기가 될지 아직 모름: 따로 둔다
        else:
            self.peak = max(self.peak, rms, self._loud)   # 끼어들기가 아니었던 큰 소리는 에코로 친다 (기준이 낮다는 뜻)
            self.run, self._loud = 0, 0.0
        if self.run >= self.need:
            frames = list(self.buf)
            self.reset()
            return frames
        return None

    def end(self) -> float:
        """리본이 말이 끝났다: 이번 에코 크기를 돌려주고 비운다"""
        peak = self.peak
        self.reset()
        self.peak = 0.0
        return peak

    def reset(self) -> None:
        self.buf.clear()
        self.run = 0
        self._loud = 0.0
