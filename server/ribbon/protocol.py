"""클라이언트 <-> 서버 메시지 정의. 자세한 설명은 docs/PROTOCOL.md"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel

RibbonState = Literal["idle", "listening", "thinking", "speaking"]
TurnState = Literal["waiting", "active", "done", "cancelled", "expired"]


class KidInfo(BaseModel):
    id: str
    name: str
    age: Optional[int] = None
    mic_channel: Optional[int] = None
    seat: Optional[int] = None
    avatar: Dict[str, Any] = {}
    present: bool = False


class TurnInfo(BaseModel):
    id: str
    kid_id: str
    channel: int
    state: TurnState
    text: str = ""
    position: int = 0


class SessionSnapshot(BaseModel):
    type: Literal["state"] = "state"
    kids: List[KidInfo]
    queue: List[TurnInfo]
    ribbon: RibbonState
    target_kid: Optional[str] = None
    config: Dict[str, Any] = {}   # 관리자 설정(RibbonConfig 등). TV 가 색/이름/스프라이트에 쓴다


class SpeakMessage(BaseModel):
    type: Literal["speak"] = "speak"
    utterance_id: str
    text: str
    kid_id: Optional[str] = None
    audio_b64: Optional[str] = None  # 서버 합성(mac_say)이면 wav base64, browser 면 None
    final: bool = True               # 이 문장이 턴의 마지막인지


class RibbonStateMessage(BaseModel):
    type: Literal["ribbon.state"] = "ribbon.state"
    state: RibbonState
    target_kid: Optional[str] = None


class TranscriptMessage(BaseModel):
    type: Literal["transcript"] = "transcript"
    kid_id: Optional[str]
    channel: int
    text: str
    final: bool = True


class KidPresenceMessage(BaseModel):
    type: Literal["kid.enter", "kid.leave"]
    kid_id: str
