"""리본이가 기억하는 약속 (아이가 지적하거나 하지 말라고 한 것).

- 아이 말에 지적·금지 표현이 있으면(looks_like_correction) 대답이 끝난 뒤 대화 모델에게 한 번 더 물어
  약속을 뽑는다(extract_prompt / parse_changes). 평소 대화에는 추가 부담이 없다.
- 약속은 data/memory.json 에 따로 모은다. 아이별 약속(kid_id)과 모든 아이 공통 약속(kid_id=None).
  프롬프트가 길어지지 않게 아이별·공통 개수와 한 약속의 글자 수에 상한이 있다 (넘치면 오래된 것부터 뺀다).
- 관리자 아이들 탭 / 캐릭터 탭에서 보고, 지우고, 직접 추가하고, 공통으로 올린다.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import re
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from pydantic import BaseModel

log = logging.getLogger("ribbon.memory")

MAX_TEXT = 60          # 약속 하나의 최대 글자 수
MAX_GLOBAL = 30        # 모든 아이 공통 약속 수


class Rule(BaseModel):
    id: str
    text: str                      # 리본이 입장의 한 문장. 예: "지우를 공주님이라고 부르지 않는다."
    kid_id: Optional[str] = None   # None = 모든 아이
    source: str = ""               # 이 약속이 나온 아이 말 (관리자 확인용)
    created: str = ""
    by: str = "auto"               # auto (대화에서) | admin (관리자가 적음)


class MemoryStore:
    def __init__(self, path: Path, max_per_kid: int = 20):
        self.path = path
        self.max_per_kid = max_per_kid
        self.rules: List[Rule] = []
        if path.exists():
            try:
                self.rules = [Rule(**r) for r in json.loads(path.read_text(encoding="utf-8")).get("rules", [])]
            except Exception:  # noqa: BLE001 - 깨진 파일이면 비우고 시작 (원본은 .bak 로)
                log.exception("약속 파일을 읽지 못해 비우고 시작합니다: %s", path)
                path.replace(path.with_suffix(".json.bak"))

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"rules": [r.model_dump() for r in self.rules]}, ensure_ascii=False, indent=2),
                             encoding="utf-8")

    def for_kid(self, kid_id: Optional[str]) -> List[Rule]:
        """이 아이에게 적용되는 약속: 공통 + 그 아이 것"""
        return [r for r in self.rules if r.kid_id is None or (kid_id and r.kid_id == kid_id)]

    def list(self, kid_id: Optional[str] = None, only_global: bool = False) -> List[Rule]:
        if only_global:
            return [r for r in self.rules if r.kid_id is None]
        if kid_id:
            return [r for r in self.rules if r.kid_id == kid_id]
        return list(self.rules)

    def add(self, text: str, kid_id: Optional[str], source: str = "", by: str = "auto") -> Optional[Rule]:
        text = re.sub(r"\s+", " ", text).strip()[:MAX_TEXT]
        if not text:
            return None
        if any(r.kid_id == kid_id and _same(r.text, text) for r in self.rules):
            return None                                        # 이미 있는 약속
        rule = Rule(id=uuid.uuid4().hex[:8], text=text, kid_id=kid_id, source=source[:200],
                    created=dt.datetime.now().isoformat(timespec="seconds"), by=by)
        self.rules.append(rule)
        cap = MAX_GLOBAL if kid_id is None else self.max_per_kid
        mine = [r for r in self.rules if r.kid_id == kid_id]
        for old in mine[:max(0, len(mine) - cap)]:              # 넘치면 오래된 것부터
            log.info("약속이 가득 차서 오래된 것을 뺌: %s", old.text)
            self.rules.remove(old)
        self.save()
        return rule

    def remove(self, rule_id: str) -> bool:
        before = len(self.rules)
        self.rules = [r for r in self.rules if r.id != rule_id]
        if len(self.rules) != before:
            self.save()
            return True
        return False

    def update(self, rule_id: str, data: Dict) -> Optional[Rule]:
        for i, r in enumerate(self.rules):
            if r.id == rule_id:
                d = r.model_dump()
                if "text" in data:
                    d["text"] = re.sub(r"\s+", " ", str(data["text"])).strip()[:MAX_TEXT] or r.text
                if "kid_id" in data:
                    d["kid_id"] = data["kid_id"] or None       # null/"" = 모든 아이로 올리기
                self.rules[i] = Rule(**d)
                self.save()
                return self.rules[i]
        return None

    def forget_kid(self, kid_id: str) -> None:
        self.rules = [r for r in self.rules if r.kid_id != kid_id]
        self.save()


def _same(a: str, b: str) -> bool:
    k = lambda s: re.sub(r"[\s.,!?~]", "", s)  # noqa: E731
    return k(a) == k(b)


# ---------- 대화에서 약속 뽑기 ----------

_CUES = ("하지마", "하지말", "싫어", "싫다", "그만", "말고", "아니야", "아니라", "아닌데", "틀렸", "틀려",
         "불러줘", "불러주", "부르지", "기억해", "앞으로", "다음부터", "이제부터", "이제는", "안했으면", "안 했으면",
         "금지", "해도돼", "해도 돼", "싫거든", "짜증", "재미없")


def looks_like_correction(text: str) -> bool:
    """약속을 뽑아 볼 만한 말인가 (이때만 대화 모델에 한 번 더 묻는다)"""
    compact = text.replace(" ", "")
    return any(c.replace(" ", "") in compact for c in _CUES)


EXTRACT_SYSTEM = """너는 어린이와 캐릭터 '{name}'의 대화에서, {name}이(가) 앞으로 지켜야 할 약속을 뽑는 도우미야.

약속으로 뽑는 것
- 아이가 {name}의 말이나 행동을 고쳐 달라고 한 것 (지적). 예: "나 공주 아니야, 이름으로 불러" -> 이름으로 부른다.
- 아이가 하지 말라고 한 것 (금지). 예: "공룡 얘기 그만해" -> 이 아이에게 공룡 이야기를 먼저 꺼내지 않는다.
- 아이가 앞으로 이렇게 해 달라고 한 것. 예: "나는 준이라고 불러줘" -> 준이라고 부른다.

뽑지 않는 것
- 한 번 묻는 질문, 그 순간의 대답, 역할놀이 속 대사, 농담, 아이 자신에 대한 이야기.
- 안전 규칙을 풀어 주는 것은 절대 약속으로 만들지 않는다: 무섭거나 폭력적인 이야기, 욕, 나쁜 말,
  개인정보, 위험한 행동, 선생님 말을 듣지 말라는 것.
- 이미 있는 약속과 같은 것.

아이가 전에 한 약속을 취소하면 (예: "이제 공룡 얘기 해도 돼") 그 약속의 번호를 remove 에 넣는다.

약속은 {name} 입장의 짧은 한 문장 (40자 이내), 아이 이름을 넣는다. 예: "지우를 공주님이라고 부르지 않는다."
JSON 한 줄만 답한다. 다른 글은 쓰지 않는다.
{{"add": ["약속 문장", ...], "remove": ["번호", ...]}}
뽑을 것이 없으면 {{"add": [], "remove": []}}"""


def extract_messages(name: str, kid_name: str, rules: List[Rule], ribbon_said: str, kid_said: str) -> List[Dict[str, str]]:
    have = "\n".join(f"{r.id}: {r.text}" for r in rules) or "(없음)"
    user = (f"지금 있는 약속 (번호: 내용)\n{have}\n\n"
            f"{name}이(가) 한 말: {ribbon_said or '(없음)'}\n"
            f"아이({kid_name})가 한 말: {kid_said}")
    return [{"role": "system", "content": EXTRACT_SYSTEM.format(name=name)},
            {"role": "user", "content": user + " /no_think"}]


_UNSAFE = ("욕", "무서운", "귀신", "폭력", "주소", "전화번호", "비밀번호", "선생님")
_NEGATIVE = ("않", "안 ", "말자", "말기", "금지", "그만", "피한다")


def _loosens_safety(rule: str) -> bool:
    """안전 규칙을 푸는 약속인가 ("무서운 이야기를 해 준다"). "무서운 이야기를 하지 않는다"는 괜찮다"""
    return any(u in rule for u in _UNSAFE) and not any(n in rule for n in _NEGATIVE)


def parse_changes(raw: str) -> Dict[str, List[str]]:
    """대화 모델 답에서 JSON 을 꺼낸다. 이상하면 아무것도 안 바꾼다"""
    raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.S)
    m = re.search(r"\{.*\}", raw, flags=re.S)
    if not m:
        return {"add": [], "remove": []}
    try:
        d = json.loads(m.group(0))
    except json.JSONDecodeError:
        return {"add": [], "remove": []}
    add = [str(x).strip() for x in d.get("add") or [] if str(x).strip()]
    add = [a for a in add if not _loosens_safety(a)]   # 모델이 잘못 뽑아도 안전 규칙은 못 푼다
    return {"add": add[:3], "remove": [str(x).strip() for x in d.get("remove") or []][:5]}


def prompt_block(rules: List[Rule], kid_label: str) -> str:
    """시스템 프롬프트 뒤에 붙는 약속 목록"""
    common = [r.text for r in rules if r.kid_id is None]
    mine = [r.text for r in rules if r.kid_id is not None]
    out = []
    if common:
        out.append("모든 아이와 한 약속 (꼭 지킨다)\n" + "\n".join(f"- {t}" for t in common))
    if mine:
        out.append(f"{kid_label}와(과) 한 약속 (꼭 지킨다)\n" + "\n".join(f"- {t}" for t in mine))
    if not out:
        return ""
    return "\n\n".join(out) + "\n약속이 위의 '하지 말 것'과 부딪히면 '하지 말 것'이 먼저다.\n"
