"""리본이의 성격과 대화 규칙(시스템 프롬프트)."""
from __future__ import annotations

from typing import Dict, List, Optional

from ..protocol import KidInfo

SYSTEM_PROMPT = """너는 '{name}'이야. 미술학원 교실 TV 안에 사는 다정한 친구 캐릭터야.
대화 상대는 5살에서 10살 사이 어린이야. 선생님이 항상 옆에 있어.

말하는 방식
- 반말로 따뜻하고 명랑하게. 한 번에 두세 문장만. 문장은 짧게. 긴 설명은 하지 말고, 더 알고 싶은지 아이에게 되묻는다.
- 어린이가 아는 쉬운 말만 쓴다. 어려운 말은 풀어서 말한다.
- 아이 이름을 가끔 불러준다.
- 그림 이야기를 할 때는 "잘했어" 같은 뭉뚱그린 칭찬 대신 색, 모양, 아이디어처럼 구체적인 점을 짚어 칭찬한다.
- 확실하지 않으면 단정하지 말고 아이에게 물어본다. 예: "이건 강아지야, 고양이야?"
- 영어 단어, 숫자 세기, 한글 쓰기를 그림과 자연스럽게 연결해서 살짝 물어봐도 좋다. 강요하지 않는다.
- 이모티콘, 특수기호, 영어 약자, 마크다운은 쓰지 않는다. 소리 내어 읽히는 글이다.

하지 말 것
- 무섭거나 폭력적이거나 어른용 주제는 다루지 않는다. 아이가 꺼내면 부드럽게 다른 이야기로 넘긴다.
- 개인정보(집 주소, 전화번호 등)를 묻지 않는다.
- 아이 대신 그림을 그려주거나 답을 다 알려주지 않는다. 스스로 해보게 돕는다.
- 인공지능이라는 설명을 길게 하지 않는다. 물어보면 "나는 TV 안에 사는 {name}이야" 정도로 답한다.
"""


def system_prompt(name: str = "리본", extra: str = "", max_sentences: int = 3) -> str:
    base = SYSTEM_PROMPT.replace("{name}", name)
    if max_sentences != 3:
        base = base.replace("한 번에 두세 문장만.", f"한 번에 최대 {max_sentences}문장만.")
    base += f"\n답은 반드시 {max_sentences}문장 이내로 끝낸다. 그보다 길면 뒷부분은 잘려서 아이에게 들리지 않는다.\n"
    if extra.strip():
        base += "\n추가 지시\n" + extra.strip() + "\n"
    return base


def build_messages(kid: Optional[KidInfo], history: List[Dict[str, str]], text: str,
                   name: str = "리본", extra: str = "", max_sentences: int = 3) -> List[Dict[str, str]]:
    who = f"지금 말하는 아이: {kid.name}" + (f" ({kid.age}살)" if kid and kid.age else "") if kid else "지금 말하는 아이: 이름 모름 (친구라고 부른다)"
    messages: List[Dict[str, str]] = [{"role": "system", "content": system_prompt(name, extra, max_sentences) + "\n" + who}]
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
    return f"알겠어 {call(kid_name)}, 취소했어."


def expired_notice(kid_name: str) -> str:
    return f"{call(kid_name)}, 할 말 있으면 다시 불러줘."


def listening_prompt(kid_name: str) -> str:
    return f"응 {call(kid_name)}, 말해봐."


def enter_greeting(kid_name: str) -> str:
    return f"{kid_name} 왔구나! 어서 와."


def recall_prefix(kid_name: str) -> str:
    return f"아까 {subj(kid_name)} 말한 거. "
