"""얼굴 식별 인터페이스 (3단계에서 구현).

계획
- 검출 + 임베딩: insightface (buffalo_l). 얼굴 -> 512차원 벡터.
- 등록: 아이당 사진 5~10장 -> 벡터 평균을 data/faces/<kid_id>.npy 로 저장. 사진 원본은 저장하지 않는다.
- 식별: 코사인 유사도 최고값이 threshold(0.4~0.5) 이상이면 그 아이, 아니면 unknown.
- 확신이 낮을 때는 리본이가 이름을 물어 확인하고, 확인된 얼굴을 등록 벡터에 누적한다.
- 아이 얼굴은 빨리 변하므로 몇 달마다 재등록.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional


@dataclass
class FaceMatch:
    kid_id: Optional[str]
    score: float
    box: tuple  # (x, y, w, h) 0~1 정규화


class FaceIdentifier:
    def __init__(self, faces_dir: str = "../data/faces", threshold: float = 0.45):
        self.faces_dir = faces_dir
        self.threshold = threshold

    def identify(self, jpeg: bytes) -> List[FaceMatch]:
        raise NotImplementedError("3단계에서 insightface 로 구현합니다.")

    def enroll(self, kid_id: str, jpegs: List[bytes]) -> int:
        raise NotImplementedError("3단계에서 구현합니다.")
