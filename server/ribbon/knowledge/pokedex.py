"""포켓몬 도감 (data/pokedex.json, tools/fetch_pokedex.py 로 받는다).

아이 말에 포켓몬 이름이 나오면 그 포켓몬 정보를 찾아 대화 모델에 참고 자료로 준다 (지어내지 않게).
음성 인식이 이름을 조금 틀리게 적어도 ("피카추", "리자뭉") 자모 단위로 비슷한 이름을 찾는다.
"""
from __future__ import annotations

import json
import logging
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Dict, List, Optional

log = logging.getLogger("ribbon.pokedex")

_CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
_JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"
_JONG = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"
# 이름 뒤에 붙는 조사·말끝 (긴 것부터 뗀다)
_TAIL = sorted(["이랑", "하고", "한테", "처럼", "보다", "이는", "이가", "이도", "이야", "이의", "이를",
                "는", "은", "이", "가", "를", "을", "도", "랑", "의", "야", "아", "요", "만", "에", "로"],
               key=len, reverse=True)


# 포켓몬 이름이지만 일상에서도 쓰는 말: "포켓몬" 이야기일 때만 도감을 찾는다 ("킹크랩 먹었어")
_EVERYDAY = {"킹크랩", "피죤", "라플라스", "나시", "캥카", "고라파덕", "캐이시", "해피너스", "버터플",
             "야도란", "모부기", "메리프", "코코리", "켄타로스", "셀러", "파라스", "아보", "케이시", "후딘"}


def jamo(s: str) -> str:
    out = []
    for ch in s:
        c = ord(ch) - 0xAC00
        if 0 <= c < 11172:
            out += [_CHO[c // 588], _JUNG[(c % 588) // 28], _JONG[c % 28].strip()]
        else:
            out.append(ch)
    return "".join(out)


# ---------- 음성 인식이 이름을 다르게 적었을 때 맞춰 보기 (2026-09-21) ----------
#: 된소리·거센소리를 예사소리로, 비슷한 모음은 하나로. 아이 발음과 Whisper 표기가 갈리는 자리다
#: ("뚜벅쵸"->"두벅초", "쁘사이저"->"부사이저", "ㅐ/ㅔ")
_SOFT = {"ㄲ": "ㄱ", "ㅋ": "ㄱ", "ㄸ": "ㄷ", "ㅌ": "ㄷ", "ㅃ": "ㅂ", "ㅍ": "ㅂ", "ㅆ": "ㅅ", "ㅉ": "ㅈ", "ㅊ": "ㅈ",
         "ㅐ": "ㅔ", "ㅒ": "ㅔ", "ㅖ": "ㅔ", "ㅙ": "ㅚ", "ㅞ": "ㅚ", "ㅘ": "ㅗ", "ㅝ": "ㅜ", "ㅢ": "ㅣ",
         # 반모음(y)도 묶는다: "뚜벅쵸" 를 "두벅초" 로 적는 일이 많다
         "ㅑ": "ㅏ", "ㅕ": "ㅓ", "ㅛ": "ㅗ", "ㅠ": "ㅜ"}
#: 숫자로 적힌 것을 한글 소리로 ("3343" -> "삼삼사삼", "삼삼드래" 를 이렇게 적는 일이 있다)
_DIGIT = {"0": "영", "1": "일", "2": "이", "3": "삼", "4": "사", "5": "오", "6": "육", "7": "칠", "8": "팔", "9": "구"}
_ROM_CHO = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"]
_ROM_JUNG = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi",
             "yu", "eu", "ui", "i"]
_ROM_JONG = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "p", "t", "t", "p", "t", "m", "p", "p", "t", "t",
             "ng", "t", "t", "k", "t", "p", "t"]


def soft(s: str) -> str:
    """자모로 풀고 비슷한 소리끼리 묶는다. 쌍자음·거센소리를 다르게 들어도 같은 이름으로 본다"""
    return "".join(_SOFT.get(c, c) for c in jamo(s))


def digits_to_korean(text: str) -> str:
    """숫자를 한글 소리로 바꾼 말 (인식기가 '삼'을 '3'으로 적는 경우)"""
    return "".join(_DIGIT.get(ch, ch) for ch in text)


#: 로마자도 거센소리·된소리를 예사소리로 묶는다 ("ddubeokcho" = "ttubeokchyo")
_SOFT_ROM = [("kk", "g"), ("tt", "d"), ("pp", "b"), ("jj", "j"), ("ss", "s"), ("ch", "j"),
             ("k", "g"), ("t", "d"), ("p", "b"), ("r", "l"), ("y", ""), ("w", "")]


def soft_rom(latin: str) -> str:
    out = latin.lower()
    for a, b in _SOFT_ROM:
        out = out.replace(a, b)
    return out


def romanize(name: str) -> str:
    """대충 로마자로 (인식기가 한글 대신 영어로 적었을 때 견주어 보려고)"""
    out = []
    for ch in name:
        c = ord(ch) - 0xAC00
        if 0 <= c < 11172:
            out += [_ROM_CHO[c // 588], _ROM_JUNG[(c % 588) // 28], _ROM_JONG[c % 28]]
        elif ch.isalnum():
            out.append(ch.lower())
    return "".join(out)


# 생김새 설명: 공식 그림을 그림 보는 대화 모델에게 보여 주고 받는다 (tools/make_pokemon_looks.py 와 게임 중 즉석).
# 저장소에 넣어 둔 1세대 설명 + 게임 중에 새로 만든 설명(data/pokemon_looks_cache.json)
LOOKS_FILE = Path(__file__).with_name("pokemon_looks.json")
LOOK_PROMPT = ("이 그림은 포켓몬 '{name}'이야. 이름은 절대 말하지 말고, 5~7살 아이가 알아듣게 이 포켓몬의 생김새를 "
               "짧은 문장 4개로 설명해 줘. 첫 두 문장은 전체 색깔과 몸 모양, 뒤 두 문장은 눈에 띄는 특징"
               "(귀, 꼬리, 볼, 날개, 등, 무늬 등). 반말로 '~야', '~가 있어' 처럼 끝내고 문장마다 줄을 바꿔. 번호는 붙이지 마.")


def clean_look(text: str, name: str) -> List[str]:
    """모델 답 -> 생김새 문장들 (이름이 들어간 문장은 버린다: 정답이 새지 않게)"""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    out = []
    for line in re.split(r"\n+", text):
        line = re.sub(r"^[\s\-*\u2022\d.)]+", "", line).strip()
        if not line or name in line or "모름" in line:
            continue
        if not re.search(r"[.!?]$", line):
            line += "."
        out.append(line)
    return out[:4]


class Pokedex:
    def __init__(self, path: Path, looks_cache: Optional[Path] = None):
        self.entries: List[Dict] = []
        self._by_name: Dict[str, Dict] = {}
        self._looks_cache = looks_cache
        if path.exists():
            try:
                self.entries = json.loads(path.read_text(encoding="utf-8")).get("pokemon", [])
            except Exception:  # noqa: BLE001
                log.exception("포켓몬 도감을 읽지 못했습니다: %s", path)
        looks: Dict[str, List[str]] = {}
        for f in (LOOKS_FILE, looks_cache):
            if f and f.exists():
                try:
                    looks.update(json.loads(f.read_text(encoding="utf-8")))
                except Exception:  # noqa: BLE001
                    log.exception("생김새 설명을 읽지 못했습니다: %s", f)
        self._by_id = {e["id"]: e for e in self.entries}
        for e in self.entries:
            if str(e["id"]) in looks and not e.get("look"):
                e["look"] = looks[str(e["id"])]
        for e in self.entries:
            self._by_name[e["name"].replace(" ", "")] = e
        self._names = sorted(self._by_name, key=len, reverse=True)
        self._jamo = {n: jamo(n) for n in self._names}

    def __len__(self) -> int:
        return len(self.entries)

    def save_look(self, pid: int, lines: List[str]) -> None:
        """게임 중에 새로 만든 생김새 설명을 붙이고 저장해 둔다 (다음에는 바로 쓴다)"""
        if pid in self._by_id:
            self._by_id[pid]["look"] = lines
        if not self._looks_cache:
            return
        try:
            data = json.loads(self._looks_cache.read_text(encoding="utf-8")) if self._looks_cache.exists() else {}
            data[str(pid)] = lines
            self._looks_cache.parent.mkdir(parents=True, exist_ok=True)
            self._looks_cache.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        except OSError:
            log.exception("생김새 설명 저장 실패")

    def find(self, text: str, limit: int = 2) -> List[Dict]:
        """말 속의 포켓몬 (많아야 limit 마리). 정확히 맞는 이름이 먼저, 없으면 비슷한 이름"""
        if not self.entries:
            return []
        compact = re.sub(r"[^가-힣a-zA-Z0-9]", "", text)
        words = [self._strip(w) for w in re.findall(r"[가-힣]+", text)]
        found: List[Dict] = []
        rest = compact
        context = "포켓몬" in compact
        for n in self._names:                      # 긴 이름부터 ("뮤츠" 를 "뮤" 보다 먼저)
            if n in _EVERYDAY and not context:
                hit = False
            elif len(n) == 1:
                hit = n in words                   # 한 글자 이름("뮤")은 따로 떨어진 낱말일 때만
            else:
                hit = n in rest
            if hit:
                found.append(self._by_name[n])
                rest = rest.replace(n, "|")
                if len(found) >= limit:
                    return found
        if found:
            return found
        for w in words:
            if len(w) < 2 or (len(w) == 2 and not context):
                continue                           # 두 글자는 "포켓몬" 이야기일 때만 비슷한 이름을 찾는다
            best = self._closest(w, allow_everyday=context)
            if best and best not in found:
                found.append(best)
                if len(found) >= limit:
                    break
        return found

    @staticmethod
    def _strip(w: str) -> str:
        for t in _TAIL:
            if len(w) > len(t) + 1 and w.endswith(t):
                return w[:-len(t)]
        return w

    def _closest(self, word: str, threshold: float = 0.8, allow_everyday: bool = False) -> Optional[Dict]:
        wj = jamo(word)
        best, score = None, threshold
        for n in self._names:
            if abs(len(n) - len(word)) > 1 or (n in _EVERYDAY and not allow_everyday):
                continue
            r = SequenceMatcher(None, wj, self._jamo[n]).ratio()
            if r > score or (r == score and best is None):
                best, score = n, r
        return self._by_name[best] if best else None


def describe(e: Dict) -> str:
    """대화 모델에 줄 한 마리 정보"""
    parts = [f"No.{e['id']} {e['name']}" + (f" ({e['genus']})" if e.get("genus") else ""),
             f"타입: {'/'.join(e.get('types') or [])}",
             f"키 {e['height_m']:g}m, 몸무게 {e['weight_kg']:g}kg"]
    if e.get("look"):
        parts.append("생김새: " + " ".join(e["look"]))
    if e.get("legendary"):
        parts.append("전설/환상의 포켓몬")
    if e.get("evolution") and "→" in e["evolution"]:
        parts.append(f"진화: {e['evolution']}")
    for f in e.get("flavor") or []:
        parts.append(f"도감: {f}")
    return "\n".join(parts)


def knowledge_block(entries: List[Dict]) -> str:
    if not entries:
        return ""
    body = "\n\n".join(describe(e) for e in entries)
    return ("참고 자료: 포켓몬 도감 (정확한 정보)\n" + body +
            "\n위 자료에서 아이가 궁금해하는 것만 골라 쉬운 말로 짧게 말한다. 도감 문장을 그대로 읽지 않는다."
            " 여기 없는 내용(기술, 약점 등)은 지어내지 말고 모른다고 한다.\n")
