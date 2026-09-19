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


class Pokedex:
    def __init__(self, path: Path):
        self.entries: List[Dict] = []
        self._by_name: Dict[str, Dict] = {}
        if path.exists():
            try:
                self.entries = json.loads(path.read_text(encoding="utf-8")).get("pokemon", [])
            except Exception:  # noqa: BLE001
                log.exception("포켓몬 도감을 읽지 못했습니다: %s", path)
        for e in self.entries:
            self._by_name[e["name"].replace(" ", "")] = e
        self._names = sorted(self._by_name, key=len, reverse=True)
        self._jamo = {n: jamo(n) for n in self._names}

    def __len__(self) -> int:
        return len(self.entries)

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
