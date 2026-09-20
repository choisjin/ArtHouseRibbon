"""포켓몬 맞추기 게임 (2026-09-20). 모두 한국어 이름 기준.

힌트는 아이가 달라고 할 때만 준다 ("힌트", "모르겠어", "어려워"). 틀린 답에는 아니라고만 한다.

- describe: 리본이가 타입·생김새·특징을 말로 설명하고 맞춘다. 어려워하면 힌트를 하나씩 더.
- image:    TV 에 포켓몬 그림을 띄우고 이름을 맞춘다. 어려워하면 글자 수 -> 초성 -> 한 글자씩.
- peek:     "조금 보고 맞추기". 그림을 90% 가리고 시작. 어려워하면 여기저기(이어지지 않게) 조금씩 더 보여 준다. 중간에 초성·글자도.

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
MODE_NAME = {"describe": "설명 듣고 맞추기", "image": "그림 보고 맞추기", "peek": "조금 보고 맞추기"}
MODE_SUB = {"describe": "리본이 설명을 듣고 누구인지 맞혀요", "image": "그림을 보고 이름을 맞혀요",
            "peek": "조금만 보이는 그림을 보고 맞혀요"}
GRID = 6                                    # 조금 보고 맞추기: 6x6 = 36칸
MODE_ART = {"describe": 25, "image": 133, "peek": 94}   # 게임 표지에 나오는 포켓몬 (피카츄·이브이·팬텀)
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


def _with_rang(words: List[str]) -> str:
    """["고스트", "독"] -> "고스트랑 독", ["바위", "물"] -> "바위랑 물", ["풀", "독"] -> "풀이랑 독" """
    return " ".join(w + (("이랑" if _batchim(w) else "랑") if i < len(words) - 1 else "") for i, w in enumerate(words))


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


# 음성 인식이 "포켓몬" 을 다르게 적는 경우들
_POKEMON_WORDS = ("포켓몬", "포캣몬", "포켄몬", "포케몬", "포켓몽", "포켄몽", "포게몬", "포켓문", "pokemon", "포켓")
_GAME_WORDS = ("맞추", "맞히", "맞춰", "맞혀", "맞출", "맞힐", "마추", "마춰", "마치기", "맞치", "퀴즈", "게임", "누구게",
               "알아맞", "문제내", "문제 내", "이름맞")


# 놀자는 말 (2026-09-20 "게임하자, 놀이하자, 놀아줘 등 놀이와 관련된 모든 말로"). 지금 게임은 포켓몬 맞추기뿐이라 그 고르기 화면을 연다
_PLAY_DIRECT = ("놀자", "놀아줘", "놀아주", "놀래", "놀까", "놀고싶", "노는거하자", "심심", "뭐하고놀", "뭐할까",
                "뭐하지", "재밌는거", "재미있는거", "할거없", "할게없")
_PLAY_WORDS = ("게임", "놀이", "퀴즈", "맞추기", "맞히기", "수수께끼")
_PLAY_ASK = ("하자", "할래", "해줘", "해주", "하고싶", "할까", "해요", "시작", "내줘", "내봐", "하쟈", "할꺼")
_NOT_PLAY = ("놀이터", "놀이공원", "놀이동산")   # 장소 이야기


def detect_start(text: str) -> Optional[str]:
    """게임(놀이)을 하자는 말인가. 하자는 말이면 모드("" 는 아직 안 고름), 아니면 None.
    "친구랑 게임했어" 처럼 지난 이야기는 게임을 열지 않는다 (하자·할래·해줘… 가 붙을 때만)"""
    c = _compact(text).lower()
    pokemon_game = any(w in c for w in _POKEMON_WORDS) and any(k.replace(" ", "") in c for k in _GAME_WORDS)
    rest = c
    for w in _NOT_PLAY:
        rest = rest.replace(w, "")
    direct = any(w in rest for w in _PLAY_DIRECT)
    asked = any(w in rest for w in _PLAY_WORDS) and (any(a in rest for a in _PLAY_ASK) or rest in _PLAY_WORDS)
    if not (pokemon_game or direct or asked):
        return None
    return detect_mode(text) or ""


def detect_mode(text: str) -> Optional[str]:
    c = _compact(text)
    # 3번(조금 보고)을 먼저: "조금 보고" 에도 "보고" 가 있어서 2번(그림 보고)으로 가지 않게
    if any(k in c for k in ("조금보", "조금만", "쪼금", "가린", "가려", "가리고", "숨은", "숨긴", "숨겨", "일부", "부분",
                            "세번째", "3번", "삼번")):
        return "peek"
    if any(k in c for k in ("그림", "사진", "이미지", "보고", "두번째", "2번")):
        return "image"
    if any(k in c for k in ("설명", "듣고", "말로", "특징", "첫번째", "1번", "일번")):
        return "describe"
    return None


# 긍정·부정 대답 (할까? / 이걸로 할까? / 하나 더 할래?). 부정이 먼저다 ("안 좋아" 는 싫다는 말)
_NO_WORDS = ("아니", "아냐", "아뇨", "아녀", "싫어", "싫다", "싫은데", "싫거든", "안해", "안할", "안하고", "하기싫",
             "됐어", "됐다", "괜찮아", "괜찮습니다", "별로", "그만", "다음에", "나중에", "말고", "다른거", "다른걸",
             "바꿀래", "바꿔", "안좋아", "no", "노노", "놉")
_YES_WORDS = ("좋아", "좋지", "좋다", "좋아요", "그래", "그러자", "그럴래", "할래", "하자", "해줘", "할게", "해요",
              "당연하지", "당연", "물론", "고고", "가자", "렛츠고", "시작", "알았어", "알겠어", "오케이", "ok", "okay",
              "콜", "넵", "넹", "네네", "응응", "그걸로", "이걸로", "재밌겠다", "하고싶", "또할래", "한번더",
              "하나더", "계속")
_YES_SHORT = ("응", "어", "웅", "엉", "네", "예", "그럼", "해", "또", "yes", "예스")   # 짧은 대답의 첫머리일 때만 ("어제" 는 아님)


def _is_no(text: str) -> bool:
    c = _compact(text).lower()
    return any(w in c for w in _NO_WORDS) or c in ("노", "안돼")


def _is_yes(text: str) -> bool:
    if _is_no(text):
        return False
    c = _compact(text).lower()
    return any(w in c for w in _YES_WORDS) or (len(c) <= 4 and any(c.startswith(w) for w in _YES_SHORT))


def _leftover(text: str) -> str:
    """거절 말을 뺀 나머지 ("아니 소꿉놀이 하자" -> "소꿉놀이하자"). 다른 하고 싶은 게 있는지 보려고"""
    c = _compact(text).lower()
    for w in sorted(_NO_WORDS, key=len, reverse=True):
        c = c.replace(w, "")
    for w in ("그냥", "나", "난", "응", "어", "음", "이제", "리본아", "리본", "야", "요"):
        c = c.replace(w, "") if len(w) > 1 else c
    return c


def explicit_pokemon(text: str) -> bool:
    """"포켓몬 맞추기 하자" 처럼 게임을 콕 집어 말했나 (그러면 할지 다시 묻지 않는다)"""
    c = _compact(text).lower()
    return any(w in c for w in _POKEMON_WORDS) and any(k.replace(" ", "") in c for k in _GAME_WORDS)


@dataclass
class Reply:
    lines: List[str] = field(default_factory=list)
    ended: bool = False              # 게임이 끝났다
    new_round: bool = False          # 새 문제 (describe 면 생김새 힌트를 만들어 둔다)
    passthrough: bool = False        # 게임과 상관없는 말: 게임을 끝내고 보통 대화로
    auto_next: bool = False          # 정답을 보여 준 뒤 다음 문제로 (dialogue 가 잠깐 쉬고 next_round 를 부른다)


class PokemonQuiz:
    def __init__(self, pokedex: Pokedex, rng: Optional[random.Random] = None):
        self.dex = pokedex
        self.rng = rng or random.Random()
        self.active = False
        self.phase = ""              # offer (할까?) | choosing (고르기 화면) | confirm (고른 것 확인) | playing | revealed
        self.mode = ""
        self.answer: Optional[Dict] = None
        self.hints: List[str] = []   # 남은 힌트 종류
        self.shown: List[int] = []   # 조금 보고 맞추기에서 보이는 칸
        self.letters = 0             # 이름판에서 공개한 글자 수
        self.cho = False             # 이름판에 초성을 보였나
        self.count = False           # 이름판에 글자 수(빈칸)를 보였나
        self.solved = False
        self.appearance: List[str] = []   # 대화 모델이 만든 생김새 설명 (describe)
        self.pending = ""            # 고르기 화면에서 고른 게임 (확인 전)
        self.max_id = 1025
        self.recent: List[int] = []
        self.last_at = 0.0
        self.thumbs_dirs: List = []  # MLX 로 만든 게임 표지 폴더들, 앞의 것이 먼저 (main 이 정한다)

    # ---------- 시작·끝 ----------
    def offer(self, mode: str = "") -> Reply:
        """놀자는 말에: 화면을 열기 전에 먼저 할지 묻는다"""
        self.active = True
        self.last_at = time.time()
        self.phase = "offer"
        self.pending = mode if mode in MODES else ""
        return Reply(["포켓몬 맞추기 할까?"])

    def open_menu(self, mode: str = "") -> Reply:
        """아이가 하자고 할 때: TV 에 게임 고르기 화면. 이미 게임을 말했으면 그걸 골라 두고 한 번 더 묻는다"""
        self.active = True
        self.last_at = time.time()
        self.phase = "choosing"
        self.pending = ""
        if mode in MODES:
            return self._pick(mode, intro="좋아!")
        return Reply(["좋아, 포켓몬 맞추기 하자! 1번 설명 듣고 맞추기, 2번 그림 보고 맞추기, 3번 조금 보고 맞추기. 뭐 할래?"])

    def _pick(self, mode: str, intro: str = "") -> Reply:
        """고른 게임을 TV 에서 반짝이게 하고 맞는지 묻는다"""
        self.pending = mode
        self.phase = "confirm"
        return Reply([f"{intro} {MODE_NAME[mode]}! 이걸로 할까?".strip()])

    def start(self, mode: str = "") -> Reply:
        """바로 시작 (확인을 받았거나 선생님이 대시보드에서 누름). mode 가 없으면 고르기 화면"""
        if mode not in MODES:
            return self.open_menu()
        self.active = True
        self.last_at = time.time()
        self.pending = ""
        self.mode = mode
        r = self._new_round(lead="자, 문제!")
        r.lines.insert(0, f"좋아, {MODE_NAME[mode]} 시작!")
        return r

    def next_round(self) -> Reply:
        """정답을 보여 준 뒤 이어지는 다음 문제 (그만할 때까지 계속, dialogue._quiz_reply 가 부른다)"""
        return self._new_round(lead="다음 문제!")

    def stop(self) -> Reply:
        name = self.answer["name"] if self.answer and self.phase == "playing" and not self.solved else ""
        self.active = False
        self.phase = ""
        return Reply([f"알겠어, 포켓몬 맞추기 끝! 정답은 {ieosseo(name)}." if name else "알겠어, 포켓몬 맞추기 끝! 재미있었다."],
                     ended=True)

    def thumb_file(self, mode: str):
        """게임 표지 파일: 맥미니에서 만든 data/game_thumbs/*.png, 없으면 저장소에 넣어 둔 client/.../game_thumbs/*.jpg"""
        for d in self.thumbs_dirs:
            for ext in ("png", "jpg"):
                f = d / f"{mode}.{ext}"
                if f.exists():
                    return f
        return None

    def _has_thumb(self, mode: str) -> bool:
        return self.thumb_file(mode) is not None

    def _pool(self) -> List[Dict]:
        pool = [e for e in self.dex.entries if e["id"] <= self.max_id]
        if self.mode == "describe":
            pool = [e for e in pool if e.get("flavor") or e.get("genus")]
        fresh = [e for e in pool if e["id"] not in self.recent]
        return fresh or pool

    def _new_round(self, lead: str = "") -> Reply:
        self.answer = self.rng.choice(self._pool())
        self.recent = (self.recent + [self.answer["id"]])[-15:]
        self.phase = "playing"
        self.solved = False
        self.letters = 0
        self.cho = self.count = False
        self.appearance = []
        n = len(self.answer["name"])
        if self.mode == "describe":
            # 첫 문제에 정보를 넉넉히 (타입만으로는 못 맞힌다, 2026-09-20): 타입 + 분류 + 그림을 보고 만든 생김새 두 문장
            e = self.answer
            look = list(e.get("look") or [])
            genus = e.get("genus") or ""
            parts = [f"이 포켓몬은 {_with_rang(e['types'])} 타입이고"
                     + (f", {genus}{'이라고' if _batchim(genus) else '라고'} 불려." if genus else "이야.")]
            parts += look[:2]
            parts.append("누구일까?")
            first = " ".join(parts)
            self.appearance = look[2:]                             # 나머지 생김새는 힌트로
            self.hints = ["look", "look", "size", "flavor0", "evolution", "flavor1", "count", "cho", "letter"]
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
        return Reply([f"{lead} {first}".strip()], new_round=True)

    # ---------- 아이 말 ----------
    def handle(self, text: str) -> Reply:
        self.last_at = time.time()
        if self.phase == "offer":
            if _is_no(text):
                self.active = False
                self.phase = ""
                if len(_leftover(text)) >= 3:                     # "아니, 소꿉놀이 하자": 그 놀이는 대화로
                    return Reply(ended=True, passthrough=True)
                return Reply(["알겠어!"], ended=True)
            if _is_yes(text) or detect_mode(text):
                return self.open_menu(detect_mode(text) or self.pending)
            self.active = False                                    # 다른 이야기: 보통 대화로
            self.phase = ""
            return Reply(ended=True, passthrough=True)
        if self.phase == "choosing":
            mode = detect_mode(text)
            if _has(text, "그만", "안할래", "끝", "됐어"):
                return self.stop()
            if not mode and _is_no(text):
                # "아니, 소꿉놀이 하자" 같은 다른 놀이: 게임 화면을 닫고 보통 대화(대화 모델)로 같이 논다
                self.active = False
                self.phase = ""
                return Reply(ended=True, passthrough=True)
            if not mode:
                return Reply(["1번 설명 듣고, 2번 그림 보고, 3번 조금 보고 중에 골라 줘!"])
            return self._pick(mode)
        if self.phase == "confirm":
            mode = detect_mode(text)
            if _has(text, "그만할래", "안할래", "끝", "됐어"):
                return self.stop()
            if mode and mode != self.pending:
                return self._pick(mode)                           # 다른 걸 고름: 그쪽을 반짝이게
            if _is_no(text):                                       # "다른 거 할래" 는 싫다는 말 (할래 보다 먼저 본다)
                self.phase = "choosing"
                self.pending = ""
                return Reply(["그럼 뭐 할래? 1번, 2번, 3번 중에 골라 줘!"])
            if mode == self.pending or _is_yes(text):
                return self.start(self.pending)
            return Reply([f"{MODE_NAME[self.pending]} 할까? 좋으면 응 이라고 해 줘."])
        if self.phase == "revealed":
            # 정답을 보여 주고 다음 문제로 넘어가는 잠깐 사이. 그만하자는 말만 받는다
            if _is_no(text) or _has(text, "그만", "끝", "안할래"):
                return self.stop()
            return Reply()
        # playing
        if _has(text, "그만할래", "그만하자", "그만해", "게임끝", "이제그만", "안할래", "끝낼래") or _compact(text) in ("그만", "끝"):
            return self.stop()
        if self.is_correct(text):
            return self._solved(first=f"딩동댕! 정답은 {iya(self.answer['name'])}!")
        if _has(text, "정답알려", "답알려", "정답뭐", "답이뭐", "포기", "항복"):
            return self._solved(first=f"정답은 {iya(self.answer['name'])}!")
        if _has(text, "다음문제", "다른거", "다른문제", "넘어가", "패스"):
            return self._solved(first=f"정답은 {ieosseo(self.answer['name'])}!")
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

    def _solved(self, first: str) -> Reply:
        """정답을 보여 준다. 묻지 않고 다음 문제로 이어진다 (그만하자고 할 때까지, 2026-09-20 요청)"""
        self.solved = True
        self.phase = "revealed"
        e = self.answer
        lines = [first]
        if e.get("genus"):
            lines.append(f"{e['genus']}이래.")
        return Reply(lines, auto_next=True)

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
        if not self.active or self.phase == "offer":
            return None                                   # "할까?" 물을 때는 아직 화면을 열지 않는다
        if self.phase in ("choosing", "confirm"):
            # 게임 고르기 화면: 썸네일(tools/make_game_thumbs.py 가 MLX 로 만든 것)과 제목, 고른 것은 반짝
            return {"kind": "menu", "selected": self.pending or None,
                    "items": [{"mode": m, "num": i + 1, "title": MODE_NAME[m], "sub": MODE_SUB[m],
                               # 만들어 둔 표지가 있으면 그것, 없으면 공식 그림으로 TV 가 표지를 꾸민다
                               "thumb": f"/api/game/thumb/{m}" if self._has_thumb(m) else None,
                               "art": f"/api/pokemon/{MODE_ART[m]}/image"} for i, m in enumerate(MODES)]}
        if not self.answer:
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
            "kind": "play",
            "mode": self.mode,
            "image": f"/api/pokemon/{e['id']}/image" if show_img else None,
            "grid": GRID,
            "shown": None if (self.solved or self.mode != "peek") else sorted(self.shown),
            "board": board if (self.count or self.solved) else [],
            "solved": self.solved,
            "answer": name if self.solved else None,
            "types": e["types"] if self.mode == "describe" else [],
        }
