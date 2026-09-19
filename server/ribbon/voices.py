"""캐릭터 목소리 목록 (Supertonic).

기본 목소리 F1~F5, M1~M5 에 더해, 목소리 실험실(tools/voice_lab.py)에서 골라 둔 조합을 이름으로 부른다.
조합 = 음색(ttl)과 말투(dp)를 기본 목소리 비율로 섞고, 필요하면 아이 변환(WORLD: 음높이 x, 울림 x)을 건다.
캐릭터 프로필의 voice 에는 이 목록의 id 를 넣는다 (예: "F1", "YG12-2").
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

BASE_VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"]


@dataclass(frozen=True)
class VoicePreset:
    id: str
    name: str
    group: str
    ttl: Dict[str, float]                      # 음색: {기본 목소리: 비율}
    dp: Dict[str, float]                       # 말투(리듬): {기본 목소리: 비율}
    child: Optional[Tuple[float, float]] = None  # 아이 변환 (음높이 배율, 울림 배율)
    speed: Optional[float] = None              # 고르면 관리자 화면 속도 칸을 이 값으로

    def to_json(self) -> dict:
        return {"id": self.id, "name": self.name, "group": self.group, "speed": self.speed}


def _build() -> Dict[str, VoicePreset]:
    out: Dict[str, VoicePreset] = {}

    def add(p: VoicePreset) -> None:
        out[p.id] = p

    for v in BASE_VOICES:
        add(VoicePreset(v, f"{'여성' if v[0] == 'F' else '남성'} {v}", "기본 목소리", {v: 1.0}, {v: 1.0}))

    # 1차에서 고른 것 (voice_lab --set basic)
    add(VoicePreset("P1", "F1 음색 + F3 말투", "섞은 목소리", {"F1": 1.0}, {"F3": 1.0}))
    add(VoicePreset("P2", "F1 30% + F3 70%", "섞은 목소리", {"F1": .3, "F3": .7}, {"F1": .3, "F3": .7}))
    add(VoicePreset("P3", "F3 아이", "섞은 목소리", {"F3": 1.0}, {"F3": 1.0}, (1.2, 1.12)))
    add(VoicePreset("P4", "M1 아이", "섞은 목소리", {"M1": 1.0}, {"M1": 1.0}, (1.3, 1.15)))
    add(VoicePreset("P5", "M1 아이 (더 높게)", "섞은 목소리", {"M1": 1.0}, {"M1": 1.0}, (1.5, 1.2)))

    # 2차에서 고르고 3차에서 더 어리게 한 것 (voice_lab --set younger). id 는 실험실 파일 이름과 같다
    kids = [  # (실험실 이름, 그룹, 음색, 말투, 기준 아이 변환)
        ("G12", "여자아이 가 (F1 음색 + F3 말투)", {"F1": 1.0}, {"F3": 1.0}, (1.2, 1.12)),
        ("G14", "여자아이 나 (F2 음색 + F3 말투)", {"F2": 1.0}, {"F3": 1.0}, (1.2, 1.12)),
        ("G15", "여자아이 다 (F1 30% + F3 70%)", {"F1": .3, "F3": .7}, {"F1": .3, "F3": .7}, (1.2, 1.12)),
        ("B11", "남자아이 가 (M1 70% + F3 30%)", {"M1": .7, "F3": .3}, {"M1": .7, "F3": .3}, (1.25, 1.12)),
    ]
    for lab, group, ttl, dp, (p0, f0) in kids:
        add(VoicePreset(f"Y{lab}-0", "기본", group, ttl, dp, (p0, f0)))
        for i, (dp_, df) in enumerate([(0.1, 0.05), (0.2, 0.09), (0.3, 0.13), (0.4, 0.17)], 1):
            add(VoicePreset(f"Y{lab}-{i}", f"더 어리게 {i}", group, ttl, dp, (round(p0 + dp_, 2), round(f0 + df, 2))))
        add(VoicePreset(f"Y{lab}-s", "더 어리게 2 · 천천히", group, ttl, dp,
                        (round(p0 + 0.2, 2), round(f0 + 0.09, 2)), speed=0.95))
    for r in (0.4, 0.5):
        mix = {"M1": round(1 - r, 2), "F3": r}
        add(VoicePreset(f"YB11-m{int(r * 100)}", f"F3 {int(r * 100)}% 섞기 (더 어린 남자아이)",
                        "남자아이 가 (M1 70% + F3 30%)", mix, mix, (1.35, 1.17)))
    return out


PRESETS: Dict[str, VoicePreset] = _build()


def get_preset(voice: Optional[str]) -> Optional[VoicePreset]:
    return PRESETS.get(voice or "")


def list_voices() -> List[dict]:
    return [p.to_json() for p in PRESETS.values()]
