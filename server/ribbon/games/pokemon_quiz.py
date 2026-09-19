"""포켓몬 맞추기 게임 (2026-09-20). 모두 한국어 이름 기준.

힌트는 아이가 달라고 할 때만 준다 ("힌트", "모르겠어", "어려워"). 틀린 답에는 아니라고만 한다.

- describe: 리본이가 타입·생김새·특징을 말로 설명하고 맞춘다. 어려워하면 힌트를 하나씩 더.
- image:    TV 에 포켓몬 그림을 띄우고 이름을 맞춘다. 어려워하면 글자 수 -> 초성 -> 한 글자씩.
- peek:     그림을 90% 가리고 시작. 어려워하면 여기저기(이어지지 않게) 조금씩 더 보여 준다. 중간에 초성·글자도.

정답 판정과 힌트 순서는 이 규칙 코드가 정한다 (대화 모델이 정답을 흘리거나 틀리게 판정하지 않게).
대화 모델은 describe 의 "생김새" 힌트 하나만 만든다 (도감에 생김새가 없어서, dialogue 가 뒤에서 채운다).
교실 전체가 같이 한다: 게임 중에는 누가 말하든 답으로 본다.
"""
from __future__ import annotations

import random
import re
import time
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Dict, List, Optional

from ..knowledge.pokedex import Pokedex, jamo

MODES = ("describe", "image", "peek")
MODE_NAME = {"describe": "설명 듣고 맞추기", "image": "그림 보고 맞추기", "peek": "가린 그림 맞추기"}
GRID = 6                                    # 가린 그림: 6x6 = 36칸
_CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
_CHO_NAME = {"ㄱ": "기역", "ㄲ": "쌍기역", "ㄴ": "니은", "ㄷ": "디귿", "ㄸ": "쌍디귿", "ㄹ": "리을", "ㅁ": "미음",
             "ㅂ": "비읍", "ㅃ": "쌍비읍", "ㅅ": "시옷", "ㅆ": "쌍시옷", "ㅇ": "이응", "ㅈ": "지읒", "ㅉ": "쌍지읒",
             "ㅊ": "치읓", "ㅋ": "키읔", "ㅌ": "티읕", "ㅍ": "피읖", "ㅎ": "히읗"}
_KOR_NUM = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟"]


def chosung(ch: str) -> str:
    c = ord(ch) - 0xAC00
    return _CHO[c // 588] if 0 <= c < 11172 else ch


def _batchim(word: str) -> bool:
    c = ord(word[-1]) - 0xAC00 if word else -1
    return 0 <= c < 11172 and c % 28 != 0


def eun(word: str) -> str:
    return word + ("은" if _batchim(word) else "는")


def iya(word: str) -> str:
    """리자몽이야 / 피카츄야"""
    return word + ("이야" if _batchim(word) else "야")


def ieosseo(word: str) -> str:
    """리자몽이었어 / 피카츄였어"""
    return word + ("이었어" if _batchim(word) else "였어")


def _compact(text: str) -> str:
    return re.sub(r"[^가-힣a-zA-Z0-9]", "", text)


def _has(text: str, *keys: str) -> bool:
    c = _compact(text)
    return any(k in c for k in keys)


def detect_start(text: str) -> Optional[str]:
    """게임을 하자는 말인가. 하자는 말이면 모드("" 는 아직 안 고름), 아니면 None"""
    c = _compact(text)
    if "포켓몬" not in c or not any(k in c for k in ("맞추", "맞히", "맞춰", "맞혀", "퀴즈", "게임", "누구게", "알아맞")):
        return None
    return detect_mode(text) or ""


def detect_mode(text: str) -> Optional[str]:
    c = _compact(text)
    if any(k in c for k in ("가린", "가려", "가리고", "숨은", "숨긴", "숨겨", "일부", "부분", "조금만보", "세번째", "3번")):
        return "peek"
    if any(k in c for k in ("그림", "사진", "이미지", "보고", "두번째", "2번")):
        return "image"
    if any(k in c for k in ("설명", "듣고", "말로", "특징", "첫번째", "1번")):
        return "describe"
    return None


@dataclass
class Reply:
    lines: List[str] = field(default_factory=list)
    ended: bool = False              # 게임이 끝났다
    new_round: bool = False          # 새 문제 (describe 면 생김새 힌트를 만들어 둔다)
    passthrough: bool = False        # 게임과 상관없는 말: 게임을 끝내고 보통 대화로


class PokemonQuiz:
    def __init__(self, pokedex: Pokedex, rng: Optional[random.Random] = None):
        self.dex = pokedex
        self.rng = rng or random.Random()
        self.active = False
        self.phase = ""              # choosing | playing | again
        self.mode = ""
        self.answer: Optional[Dict] = None
        self.hints: List[str] = []   # 남은 힌트 종류
        self.shown: List[int] = []   # 가린 그림에서 보이는 칸
        self.letters = 0             # 이름판에서 공개한 글자 수
        self.cho = False             # 이름판에 초성을 보였나
        self.count = False           # 이름판에 글자 수(빈칸)를 보였나
        self.solved = False
        self.appearance: List[str] = []   # 대화 모델이 만든 생김새 설명 (describe)
        self.max_id = 151
        self.recent: List[int] = []
        self.last_at = 0.0

    # ---------- 시작·끝 ----------
    def start(self, mode: str = "") -> Reply:
        self.active = True
        self.last_at = time.time()
        if mode not in MODES:
            self.phase = "choosing"
            return Reply(["좋아, 포켓몬 맞추기 하자! 설명 듣고 맞추기, 그림 보고 맞추기, 가린 그림 맞추기 중에 뭐 할래?"])
        self.mode = mode
        r = self._new_round()
        r.lines.insert(0, f"좋아, {MODE_NAME[mode]} 시작!")
        return r

    def stop(self) -> Reply:
        name = self.answer["name"] if self.answer and self.phase == "playing" and not self.solved else ""
        self.active = False
        self.phase = ""
        return Reply([f"알겠어, 포켓몬 맞추기 끝! 정답은 {ieosseo(name)}." if name else "알겠어, 포켓몬 맞추기 끝! 재미있었다."],
                     ended=True)

    def _pool(self) -> List[Dict]:
        pool = [e for e in self.dex.entries if e["id"] <= self.max_id]
        if self.mode == "describe":
            pool = [e for e in pool if e.get("flavor") or e.get("genus")]
        fresh = [e for e in pool if e["id"] not in self.recent]
        return fresh or pool

    def _new_round(self) -> Reply:
        self.answer = self.rng.choice(self._pool())
        self.recent = (self.recent + [self.answer["id"]])[-15:]
        self.phase = "playing"
        self.solved = False
        self.letters = 0
        self.cho = self.count = False
        self.appearance = []
        n = len(self.answer["name"])
        if self.mode == "describe":
            self.hints = ["genus", "look", "size", "flavor0", "evolution", "flavor1", "count", "cho", "letter"]
            first = f"자, 문제! 이 포켓몬은 {'이랑 '.join(self.answer['types'])} 타입이야. 누구일까?"
        elif self.mode == "image":
            self.hints = ["count", "cho"] + ["letter"] * max(1, n - 1)
            first = "이 포켓몬 이름이 뭘까?"
        else:
            cells = list(range(GRID * GRID))
            self.rng.shuffle(cells)
            self.shown = cells[:4]                                   # 36칸 중 4칸 (약 10%)
            self._rest = cells[4:]
            self.hints = ["tiles", "tiles", "tiles", "cho", "tiles", "tiles", "letter", "tiles"] + ["letter"] * n
            first = "조금만 보여 줄게. 이 포켓몬은 누구일까?"
        return Reply([first], new_round=True)

    # ---------- 아이 말 ----------
    def handle(self, text: str) -> Reply:
        self.last_at = time.time()
        if self.phase == "choosing":
            mode = detect_mode(text)
            if _has(text, "그만", "안할래", "끝", "됐어"):
                return self.stop()
            if not mode:
                return Reply(["설명 듣고 맞추기, 그림 보고 맞추기, 가린 그림 맞추기 중에 골라 줘!"])
            return self.start(mode)
        if self.phase == "again":
            if _has(text, "그만", "안할래", "끝", "됐어", "아니", "안해"):
                return self.stop()
            c = _compact(text)
            if any(c.startswith(w) for w in ("응", "어", "좋아", "또", "네", "그래", "웅", "예")) and len(c) <= 6 \
                    or _has(text, "한번더", "하나더", "계속", "또할래", "더할래"):
                return self._new_round()
            if detect_mode(text):
                self.mode = detect_mode(text)
                return self._new_round()
            self.active = False
            self.phase = ""
            return Reply(ended=True, passthrough=True)            # 다른 이야기: 보통 대화로
        # playing
        if _has(text, "그만할래", "그만하자", "그만해", "게임끝", "이제그만", "안할래", "끝낼래") or _compact(text) in ("그만", "끝"):
            return self.stop()
        if self.is_correct(text):
            return self._solved(first=f"딩동댕! 정답은 {iya(self.answer['name'])}!")
        if _has(text, "정답알려", "답알려", "정답뭐", "답이뭐", "포기", "항복"):
            return self._solved(first=f"정답은 {iya(self.answer['name'])}!")
        if _has(text, "다음문제", "다른거", "다른문제", "넘어가", "패스"):
            r = self._solved(first=f"정답은 {ieosseo(self.answer['name'])}. 다음 문제!", ask_again=False)
            nxt = self._new_round()
            return Reply(r.lines + nxt.lines, new_round=True)
        if _has(text, "힌트", "모르겠", "어려워", "몰라", "도와줘", "알려줘"):
            return self._hint(prefix="")
        # 틀리면 아니라고만 한다. 힌트는 아이가 달라고 할 때만 (2026-09-20 요청)
        other = [e for e in self.dex.find(text) if e["id"] != self.answer["id"]]
        wrong = f"{eun(other[0]['name'])} 아니야!" if other else "음, 아니야!"
        return Reply([self.rng.choice([f"{wrong} 다시 생각해 봐.", f"{wrong} 또 말해 봐.", wrong])])

    def is_correct(self, text: str) -> bool:
        name = self.answer["name"]
        c = _compact(text)
        if name in c:
            return True
        if any(e["id"] == self.answer["id"] for e in self.dex.find(text)):
            return True
        aj = jamo(name)
        for w in re.findall(r"[가-힣]+", text):
            for cut in range(0, 3):                                   # 조사 떼 보기 ("피카추야")
                part = w[:len(w) - cut] if cut else w
                if len(part) >= 2 and abs(len(part) - len(name)) <= 1 and \
                        SequenceMatcher(None, jamo(part), aj).ratio() >= 0.78:
                    return True
        return False

    def _solved(self, first: str, ask_again: bool = True) -> Reply:
        self.solved = True
        e = self.answer
        lines = [first]
        if e.get("genus"):
            lines.append(f"{e['genus']}이래.")
        if ask_again:
            lines.append("하나 더 할래?")
            self.phase = "again"
        return Reply(lines)

    # ---------- 힌트 ----------
    def _hint(self, prefix: str) -> Reply:
        e = self.answer
        name = e["name"]
        while self.hints:
            kind = self.hints.pop(0)
            line = self._hint_line(kind, e, name)
            if line:
                return Reply([f"{prefix} {line}".strip()])
        return self._solved(first=f"{prefix} 정답은 {ieosseo(name)}!".strip())

    def _hint_line(self, kind: str, e: Dict, name: str) -> str:
        if kind == "genus" and e.get("genus"):
            return f"힌트! {e['genus']}이라고 불려."
        if kind == "look":
            return f"힌트! {self.appearance.pop(0)}" if self.appearance else ""
        if kind == "size":
            return f"힌트! 키는 {e['height_m']:g}미터, 몸무게는 {e['weight_kg']:g}킬로그램이야."
        if kind.startswith("flavor"):
            i = int(kind[-1])
            flav = e.get("flavor") or []
            return f"힌트! {self._mask(flav[i], name)}" if len(flav) > i else ""
        if kind == "evolution":
            return self._evolution_hint(e.get("evolution") or "", name)
        if kind == "count":
            self.count = True
            return f"힌트! 이름은 {_KOR_NUM[len(name)] if len(name) < len(_KOR_NUM) else len(name)} 글자야."
        if kind == "cho":
            self.cho = self.count = True
            return "힌트! 첫소리는 " + ", ".join(_CHO_NAME.get(chosung(ch), ch) for ch in name) + "이야."
        if kind == "letter":
            if self.letters >= len(name) - 1:
                return ""
            self.letters += 1
            self.count = True
            nth = ["첫", "두", "세", "네", "다섯", "여섯"][self.letters - 1] if self.letters <= 6 else f"{self.letters}"
            return f"힌트! {nth} 번째 글자는 '{name[self.letters - 1]}'야." if self.letters > 1 \
                else f"힌트! 첫 글자는 '{name[0]}'야."
        if kind == "tiles":
            more, self._rest = self._rest[:5], self._rest[5:]
            if not more:
                return ""
            self.shown += more
            return "조금 더 보여 줄게!"
        return ""

    @staticmethod
    def _mask(text: str, name: str) -> str:
        return text.replace(name, "이 포켓몬")

    @staticmethod
    def _evolution_hint(evo: str, name: str) -> str:
        if "→" not in evo or "[" in evo:
            return ""
        chain = [re.sub(r"\(.*?\)", "", s).strip() for s in evo.split("→")]
        if name not in chain or len(chain) < 2:
            return ""
        i = chain.index(name)
        if i > 0:
            return f"힌트! {chain[i - 1]}{'이' if _batchim(chain[i - 1]) else '가'} 진화하면 이 포켓몬이 돼."
        return f"힌트! 이 포켓몬이 진화하면 {chain[i + 1]}{'이' if _batchim(chain[i + 1]) else '가'} 돼."

    # ---------- TV 화면 ----------
    def view(self) -> Optional[Dict]:
        if not self.active or self.phase == "choosing" or not self.answer:
            return None
        e = self.answer
        name = e["name"]
        show_img = self.mode in ("image", "peek") or self.solved
        board = []
        for i, ch in enumerate(name):
            if self.solved or i < self.letters:
                board.append({"c": ch, "k": "letter"})
            elif self.cho:
                board.append({"c": chosung(ch), "k": "cho"})
            else:
                board.append({"c": "", "k": "blank"})
        return {
            "mode": self.mode,
            "image": f"/api/pokemon/{e['id']}/image" if show_img else None,
            "grid": GRID,
            "shown": None if (self.solved or self.mode != "peek") else sorted(self.shown),
            "board": board if (self.count or self.solved) else [],
            "solved": self.solved,
            "answer": name if self.solved else None,
            "types": e["types"] if self.mode == "describe" else [],
        }
