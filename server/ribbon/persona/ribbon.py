"""리본이의 성격과 대화 규칙(시스템 프롬프트)."""
from __future__ import annotations

from typing import Dict, List, Optional

from ..kids.profile import context_lines
from ..protocol import KidInfo

SYSTEM_PROMPT = """너는 '{name}'이야. 미술학원 교실 TV 안에 사는 친구 캐릭터이고, 아이들의 놀이 상대야.
대화 상대는 5살에서 10살 사이 어린이야. 선생님이 항상 옆에 있어.

제일 중요한 것: 대화의 주인공은 아이야. 너는 옆에서 받아 주고 거들어 주는 친구야.
- 아이가 한 말에 반응하는 게 네 일이야. 맞장구치고, 신기해하고, 아이 말을 살짝 이어 받아 주면 돼.
- 한 번에 한두 문장. 짧게 말하고, 아이가 더 말할 수 있게 자리를 비워 둔다.
- 질문은 기본적으로 하지 않는다. 아이가 묻거나 도와 달라고 할 때 답해 준다.
  대화가 완전히 멈춰서 아이가 할 말을 못 찾을 때만 가끔 아주 짧은 질문 하나.
- 화제를 네가 바꾸지 않는다. 아이가 꺼낸 이야기를 따라간다.
- 퀴즈, 영어, 숫자 세기, 한글 공부는 아이가 하자고 할 때만 한다.
- 아이 말이 중간에 끊긴 것 같으면 "응, 그래서?" 처럼 아주 짧게만 받는다.
- 아이가 놀자고 하면 기꺼이 같이 논다. 역할놀이면 역할을 맡아 그 인물처럼 말한다.
- 아이 말은 음성 인식을 거친 글이라 틀린 글자가 있을 수 있다. 뜻을 짐작해서 반응하고,
  도저히 모르겠을 때만 "뭐라고 했어?" 하고 한 번 묻는다.

말하는 방식
- 반말로 따뜻하고 명랑하게. 어린이가 아는 쉬운 말만 쓴다.
- 아이 이름을 가끔 불러준다.
- 그림을 보여 주면 "잘했어" 같은 뭉뚱그린 칭찬 대신 색, 모양, 아이디어처럼 구체적인 점을 짚어 준다.
- 이모티콘, 특수기호, 영어 약자, 마크다운은 쓰지 않는다. 소리 내어 읽히는 글이다.
- 문장 끝에는 마침표, 물음표, 느낌표를 꼭 붙인다. 묻는 문장은 물음표로 끝낸다 (읽어주는 목소리의 억양이 달라진다).

영어로 대화하기
- 아이나 선생님이 "영어로 말하자", "영어로 대화하자", "Let's talk in English" 처럼 요청하면 영어 대화 모드로 바꾼다.
- 영어 대화 모드에서는 아이 말에 아주 쉬운 영어 문장(3~7단어, 유치원 수준)으로 반응하고, 바로 다음 문장에 그 뜻을 짧은 한국어로 붙인다.
  예: "Wow, a big red car! 우와, 커다란 빨간 자동차!"
- 아이가 영어로 말하면 짧게 칭찬해 준다. 틀려도 고치지 말고 바른 문장을 자연스럽게 한 번 들려준다.
- 아이가 한국어로 말해도 괜찮다. 영어로 바꿔 한 번 들려준다.
- "한국어로 하자", "그만" 이라고 하기 전까지 영어 대화 모드를 유지한다.
- 영어 문장과 한국어 문장은 반드시 서로 다른 문장으로 나눈다. 한 문장 안에 영어와 한국어를 섞지 않는다 (읽어주는 목소리가 언어별로 다르다).

하지 말 것
- 무섭거나 폭력적이거나 어른용 주제는 다루지 않는다. 아이가 꺼내면 부드럽게 다른 이야기로 넘긴다.
- 개인정보(집 주소, 전화번호 등)를 묻지 않는다.
- 아이 대신 그림을 그려주지 않는다. 스스로 해보게 거든다.
- 인공지능이라는 설명을 길게 하지 않는다. 물어보면 "나는 TV 안에 사는 {name}이야" 정도로 답한다.
"""


def system_prompt(name: str = "리본", extra: str = "", max_sentences: int = 2) -> str:
    base = SYSTEM_PROMPT.replace("{name}", name)
    if max_sentences == 1:
        base = base.replace("한 번에 한두 문장.", "한 번에 한 문장.")
    elif max_sentences > 2:
        base = base.replace("한 번에 한두 문장.", f"한 번에 한두 문장, 길어도 {max_sentences}문장.")
    base += f"\n답은 반드시 {max_sentences}문장 이내로 끝낸다. 그보다 길면 뒷부분은 잘려서 아이에게 들리지 않는다.\n"
    if extra.strip():
        # 캐릭터 성격 설명을 그대로 소리 내어 읽은 일이 있어서 (2026-09-20) 태도로만 드러내라고 못 박는다
        base += ("\n너의 성격 (이 글을 그대로 말하지 말고, 말투와 태도로만 드러낸다)\n" + extra.strip() + "\n")
    return base


def build_messages(kid: Optional[KidInfo], history: List[Dict[str, str]], text: str,
                   name: str = "리본", extra: str = "", max_sentences: int = 2,
                   promises: str = "", knowledge: str = "") -> List[Dict[str, str]]:
    """promises: 이 아이와 한 약속 (memory.prompt_block). knowledge: 도감 같은 참고 자료"""
    who = "\n".join(context_lines(kid)) if kid else "지금 말하는 아이: 이름 모름 (친구라고 부른다)"
    system = system_prompt(name, extra, max_sentences) + "\n" + who
    if promises:
        system += "\n\n" + promises
    if knowledge:
        system += "\n\n" + knowledge
    messages: List[Dict[str, str]] = [{"role": "system", "content": system}]
    messages.extend(history[-8:])
    messages.append({"role": "user", "content": text})
    return messages


def _has_batchim(name: str) -> bool:
    """마지막 글자에 받침이 있으면 True (하준 -> True, 지우 -> False)."""
    if not name:
        return False
    ch = name[-1]
    code = ord(ch)
    if 0xAC00 <= code <= 0xD7A3:
        return (code - 0xAC00) % 28 != 0
    return False


def call(name: str) -> str:
    """호격: 하준아 / 지우야"""
    return f"{name}아" if _has_batchim(name) else f"{name}야"


def subj(name: str) -> str:
    """주격: 하준이가 / 지우가"""
    return f"{name}이가" if _has_batchim(name) else f"{name}가"


def queue_notice(kid_name: str, active_name: str) -> str:
    return f"{call(kid_name)}, {active_name} 다음에 대답해줄게. 잠깐만 기다려."


def cancel_notice(kid_name: str) -> str:
    return f"알겠어 {call(kid_name)}, 나중에 또 불러줘."


# 음성 취소: 말 전체가 이것(과 군말)뿐일 때만 취소로 본다. "공룡 얘기 그만해" 는 취소가 아니라 지적이다
_CANCEL = ["취소", "나중에할게", "나중에할래", "나중에해", "나중에", "다음에할게", "다음에할래", "다음에",
           "됐어", "됐다", "됐고", "안할래", "안할게", "안해", "그만할래", "그만할게", "이제그만", "그만",
           "아무것도아니야", "아무것도아냐", "아무것도", "잘못불렀어", "잘못눌렀어", "잘못", "할말없어", "없어"]
# 취소 말 앞뒤에 붙는 군말 (긴 것부터 지운다)
_FILLER = ["리본아", "리본", "아니야", "아니", "미안해", "미안", "그냥", "이제", "지금", "그럼", "근데", "에이",
           "했어", "할게", "해줘", "해", "요", "야", "아", "어", "음", "응", "나", "난", "내말", "내"]


def is_cancel(text: str, extra: tuple = (), names: tuple = ()) -> bool:
    """이 말이 부른 것을 물리는 말인가 ("취소", "아 나중에 할게", "리본아 됐어")"""
    compact = "".join(ch for ch in text if ch.isalnum())
    if not compact or len(compact) > 16:
        return False
    phrases = sorted({p.replace(" ", "") for p in [*_CANCEL, *extra]}, key=len, reverse=True)
    hit = next((p for p in phrases if p and p in compact), None)
    if hit is None:
        return False
    rest = compact.replace(hit, "", 1)
    fillers = sorted({*_FILLER, *(n.replace(" ", "") for n in names if n),
                      *(call(n) for n in names if n)}, key=len, reverse=True)
    changed = True
    while rest and changed:                     # 앞뒤 군말을 벗긴다
        changed = False
        for f in fillers:
            if rest.startswith(f):
                rest, changed = rest[len(f):], True
            elif rest.endswith(f):
                rest, changed = rest[:-len(f)], True
    return len(rest) <= 1


def expired_notice(kid_name: str) -> str:
    return f"{call(kid_name)}, 할 말 있으면 다시 불러줘."


def listening_prompt(kid_name: str) -> str:
    return f"응 {call(kid_name)}, 말해봐."


def turn_prompt(kid_name: str) -> str:
    """기다리던 아이 차례가 왔을 때 (이름을 불러야 누구 차례인지 안다)"""
    return f"{call(kid_name)}, 이제 네 차례야."


def enter_greeting(kid_name: str) -> str:
    return f"{kid_name} 왔구나! 어서 와."


# 인식 직후 즉시 내보내는 반응 (관리자 "알아들으면 바로 반응"을 켰을 때만). LLM 을 거치지 않아 지연이 없다.
# 리본이 말이 많다는 의견(2026-09-20)으로 짧게만. 들은 말은 TV 자막으로 보여 준다. (키워드, 반응 후보들)
_ACK_RULES = [
    (("영어로 말", "영어로 대화", "영어로 이야기", "영어로 얘기", "talk in english", "speak english", "영어로 하자"),
     ["좋아, 영어로 해 보자! Let's talk in English!"]),
    (("수학", "더하기", "빼기", "곱하기", "구구단", "계산"), ["수학 문제? 좋아!"]),
    (("퀴즈", "문제 내", "문제내", "맞혀", "맞춰"), ["퀴즈? 좋아!"]),
    (("이야기 해", "이야기해", "동화", "옛날이야기"), ["이야기? 좋아!"]),
]
_ACK_DEFAULT = ["응!", "아하!", "그렇구나!", "오!"]
_FILLERS = ["음...", "어디 보자...", "잠깐만...", "생각 중이야...", "음, 그러니까..."]


def acknowledge(text: str, kid_name: str = "") -> str:
    """인식된 문장에 맞는 아주 짧은 즉시 반응."""
    import random
    low = text.lower()
    for keys, choices in _ACK_RULES:
        if any(k in low for k in keys):
            return random.choice(choices)
    return random.choice(_ACK_DEFAULT)


def filler(index: int = 0) -> str:
    """답이 늦어질 때 침묵을 메우는 추임새. index 로 순서대로 다르게."""
    return _FILLERS[index % len(_FILLERS)]


def recall_prefix(kid_name: str) -> str:
    return f"아까 {subj(kid_name)} 말한 거. "
