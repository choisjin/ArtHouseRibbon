"""순서 대기열(TurnQueue).

규칙
- 호출("리본아")이 감지되면 그 아이의 턴을 줄 뒤에 붙인다. 이미 줄에 있으면 새로 만들지 않는다.
- 활성 턴이 없으면 바로 활성화한다.
- 대기 중에도 그 아이의 말은 턴에 계속 기록된다(차례가 오면 다시 말할 필요 없음).
- "내 말 취소" 는 해당 채널의 대기/활성 턴을 취소한다.
- 활성 턴이 끝나면 다음 대기 턴을 활성화한다.
- 오래 기다렸는데 말이 없는 턴은 만료된다.

이 모듈은 asyncio 나 I/O 에 의존하지 않는 순수 로직이라 테스트가 쉽다.
"""
from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from .protocol import TurnInfo, TurnState

_ids = itertools.count(1)


@dataclass
class Turn:
    kid_id: str
    channel: int
    created_at: float
    id: str = field(default_factory=lambda: f"t{next(_ids)}")
    state: TurnState = "waiting"
    text: str = ""
    last_text_at: Optional[float] = None
    activated_at: Optional[float] = None

    def append_text(self, text: str, now: float) -> None:
        text = text.strip()
        if not text:
            return
        self.text = f"{self.text} {text}".strip() if self.text else text
        self.last_text_at = now

    def to_info(self, position: int) -> TurnInfo:
        return TurnInfo(id=self.id, kid_id=self.kid_id, channel=self.channel,
                        state=self.state, text=self.text, position=position)


class TurnQueue:
    def __init__(self) -> None:
        self._turns: List[Turn] = []   # 활성 턴이 있으면 항상 index 0

    # ---- 조회 ----
    def active(self) -> Optional[Turn]:
        if self._turns and self._turns[0].state == "active":
            return self._turns[0]
        return None

    def waiting(self) -> List[Turn]:
        return [t for t in self._turns if t.state == "waiting"]

    def find_by_channel(self, channel: int) -> Optional[Turn]:
        for t in self._turns:
            if t.channel == channel and t.state in ("waiting", "active"):
                return t
        return None

    def position_of(self, turn: Turn) -> int:
        """0 = 지금 대답 중, 1 = 다음, ... / 줄에 없으면 -1"""
        live = self._live()
        return live.index(turn) if turn in live else -1

    def snapshot(self) -> List[TurnInfo]:
        return [t.to_info(i) for i, t in enumerate(self._live())]

    def __len__(self) -> int:
        return len(self._live())

    # ---- 변경 ----
    def request(self, kid_id: str, channel: int, now: Optional[float] = None) -> Tuple[Turn, int, bool]:
        """호출 처리. (턴, 순서, 새로 만들어졌는지) 반환."""
        now = time.time() if now is None else now
        existing = self.find_by_channel(channel)
        if existing:
            return existing, self.position_of(existing), False
        turn = Turn(kid_id=kid_id, channel=channel, created_at=now)
        self._turns.append(turn)
        if self.active() is None:
            self._activate(turn, now)
        return turn, self.position_of(turn), True

    def add_text(self, channel: int, text: str, now: Optional[float] = None) -> Optional[Turn]:
        now = time.time() if now is None else now
        turn = self.find_by_channel(channel)
        if turn is None:
            return None
        turn.append_text(text, now)
        return turn

    def cancel(self, channel: int) -> Optional[Turn]:
        turn = self.find_by_channel(channel)
        if turn is None:
            return None
        was_active = turn.state == "active"
        turn.state = "cancelled"
        self._turns.remove(turn)
        if was_active:
            self._promote()
        return turn

    def complete_active(self, now: Optional[float] = None) -> Optional[Turn]:
        """활성 턴을 끝내고 다음 턴을 활성화해 반환."""
        now = time.time() if now is None else now
        turn = self.active()
        if turn is None:
            return None
        turn.state = "done"
        self._turns.remove(turn)
        return self._promote(now)

    def expire(self, now: float, waiting_timeout: float) -> List[Turn]:
        """말 없이 오래 기다린 대기 턴을 만료시켜 반환."""
        expired: List[Turn] = []
        for t in list(self._turns):
            if t.state == "waiting" and not t.text and now - t.created_at > waiting_timeout:
                t.state = "expired"
                self._turns.remove(t)
                expired.append(t)
        return expired

    # ---- 내부 ----
    def _live(self) -> List[Turn]:
        return [t for t in self._turns if t.state in ("waiting", "active")]

    def _activate(self, turn: Turn, now: float) -> None:
        turn.state = "active"
        turn.activated_at = now
        self._turns.remove(turn)
        self._turns.insert(0, turn)

    def _promote(self, now: Optional[float] = None) -> Optional[Turn]:
        now = time.time() if now is None else now
        for t in self._turns:
            if t.state == "waiting":
                self._activate(t, now)
                return t
        return None
