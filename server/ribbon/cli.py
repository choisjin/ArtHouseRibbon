"""터미널 채팅: 키보드로 리본이에게 말하고 답을 본다. LLM/TTS 설정 검증용.

실행:  cd server && python -m ribbon.cli
명령:  /kid 민수   말하는 아이 바꾸기
       /tts        음성 읽기 켜고 끄기 (mac_say 일 때 afplay 로 재생)
       /reset      대화 기록 지우기
       /quit       종료
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional

from .config import settings
from .kids.registry import KidRegistry
from .persona import ribbon as persona
from .protocol import KidInfo
from .providers.llm import make_llm
from .providers.tts import make_tts


async def _play(wav: bytes) -> None:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(wav)
        path = Path(f.name)
    try:
        if sys.platform == "darwin":
            p = await asyncio.create_subprocess_exec("afplay", str(path))
            await p.wait()
        else:
            print(f"(재생 생략: {path})")
    finally:
        path.unlink(missing_ok=True)


async def main() -> None:
    kids = KidRegistry.load(settings.kids_path())
    llm = make_llm(settings)
    tts = make_tts(settings)
    kid: Optional[KidInfo] = kids.all()[0] if kids.all() else None
    history: List[Dict[str, str]] = []
    speak = settings.tts_provider != "browser"

    print(f"리본 CLI  llm={settings.llm_provider}:{settings.llm_model}  tts={settings.tts_provider}  "
          f"아이={kid.name if kid else '없음'}  (/quit 종료, /kid 이름, /tts, /reset)")
    loop = asyncio.get_running_loop()
    while True:
        try:
            prompt = f"{kid.name if kid else '나'}> "
            text = (await loop.run_in_executor(None, input, prompt)).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not text:
            continue
        if text in ("/quit", "/q", "/exit"):
            break
        if text == "/reset":
            history.clear()
            print("(기록 지움)")
            continue
        if text == "/tts":
            speak = not speak
            print(f"(음성 {'켬' if speak else '끔'})")
            continue
        if text.startswith("/kid"):
            name = text[4:].strip()
            found = next((k for k in kids.all() if k.name == name), None)
            if found:
                kid = found
                history.clear()
                print(f"(이제 {kid.name} 차례)")
            else:
                print("(모르는 이름) " + ", ".join(k.name for k in kids.all()))
            continue

        messages = persona.build_messages(kid, history, text)
        print("리본> ", end="", flush=True)
        full = ""
        try:
            async for delta in llm.stream(messages):
                full += delta
                print(delta, end="", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"\n(LLM 오류: {e})")
            continue
        print()
        history.append({"role": "user", "content": text})
        history.append({"role": "assistant", "content": full.strip()})
        del history[:-16]
        if speak and full.strip():
            wav = await tts.synthesize(full.strip())
            if wav:
                await _play(wav)


if __name__ == "__main__":
    asyncio.run(main())
