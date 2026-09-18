"""LLM 제공자.

- MockLLM: 모델 없이 흐름 확인용 고정 답변
- OpenAICompatLLM: Ollama, mlx-lm server, mlx-serve 등 OpenAI 호환 /chat/completions 스트리밍
- OllamaLLM: Ollama 자체 API

제공자 이름: mlx (맥미니 mlx-serve = OpenAI 호환 + 모델 자동 올리기) | ollama | openai | mock
"""
from __future__ import annotations

import json
from typing import Any, AsyncIterator, Dict, List, Optional, Protocol

import httpx

from ..config import Settings

Message = Dict[str, str]

#: 주소를 비워 두면 쓰는 제공자별 기본 주소
DEFAULT_URLS = {"mlx": "http://localhost:11234/v1", "ollama": "http://localhost:11434/v1",
                "openai": "http://localhost:8080/v1"}


class LLM(Protocol):
    async def stream(self, messages: List[Message]) -> AsyncIterator[str]: ...


class MockLLM:
    def __init__(self, delay_s: float = 0.0):
        self.delay_s = delay_s

    async def stream(self, messages: List[Message]) -> AsyncIterator[str]:
        import asyncio
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        reply = f"응, 들었어! '{user[:20]}' 라고 했지? 정말 재미있는 생각이다. 조금 더 이야기해 줄래?"
        for piece in reply.split(" "):
            yield piece + " "


class OpenAICompatLLM:
    def __init__(self, settings: Settings):
        self.base_url = settings.llm_base_url.rstrip("/")
        self.model = settings.llm_model
        self.api_key = settings.llm_api_key
        self.max_tokens = settings.llm_max_tokens
        self.no_think = settings.llm_no_think
        self.autoload = settings.llm_autoload
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=5.0))

    async def _ensure_loaded(self, headers: Dict[str, str]) -> None:
        """mlx-serve: 모델이 내려가 있으면 올린다 (이미 올라가 있으면 몇 ms). 실패해도 답하기는 해 본다"""
        try:
            await self._client.post(f"{self.base_url}/load-model", json={"model": self.model},
                                    headers=headers, timeout=120.0)
        except httpx.HTTPError:
            pass

    async def stream(self, messages: List[Message]) -> AsyncIterator[str]:
        if self.no_think and messages and messages[-1]["role"] == "user":
            # Qwen3 소프트 스위치: 마지막 사용자 메시지에 /no_think 를 붙이면 생각 없이 바로 답한다
            messages = messages[:-1] + [{"role": "user", "content": messages[-1]["content"] + " /no_think"}]
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "max_tokens": self.max_tokens,
            "temperature": 0.7,
        }
        if self.no_think:
            payload["chat_template_kwargs"] = {"enable_thinking": False}  # vLLM / mlx-lm 용, Ollama 는 무시
        headers = {"Authorization": f"Bearer {self.api_key}"}
        if self.autoload:
            await self._ensure_loaded(headers)
        in_think = False  # qwen3 계열의 <think> 블록은 아이에게 읽어주지 않는다
        async with self._client.stream("POST", f"{self.base_url}/chat/completions",
                                       json=payload, headers=headers) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    d = json.loads(data)["choices"][0]["delta"]
                except (KeyError, IndexError, json.JSONDecodeError):
                    continue
                delta = d.get("content") or ""  # reasoning / reasoning_content 필드는 읽어주지 않는다
                if not delta:
                    continue
                if "<think>" in delta:
                    in_think = True
                    delta = delta.split("<think>")[0]
                if in_think:
                    if "</think>" in delta:
                        in_think = False
                        delta = delta.split("</think>", 1)[1]
                    else:
                        continue
                if delta:
                    yield delta

    async def aclose(self) -> None:
        await self._client.aclose()


class OllamaLLM:
    """Ollama 자체 API(/api/chat). think=false 로 qwen3 생각 모드를 확실히 끈다."""

    def __init__(self, settings: Settings):
        base = settings.llm_base_url.rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3]
        self.base_url = base
        self.model = settings.llm_model
        self.max_tokens = settings.llm_max_tokens
        self.no_think = settings.llm_no_think
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=5.0))

    async def stream(self, messages: List[Message]) -> AsyncIterator[str]:
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "think": not self.no_think,
            "options": {"num_predict": self.max_tokens, "temperature": 0.7},
        }
        async with self._client.stream("POST", f"{self.base_url}/api/chat", json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("error"):
                    raise RuntimeError(obj["error"])
                delta = (obj.get("message") or {}).get("content") or ""
                if delta:
                    yield delta
                if obj.get("done"):
                    break

    async def aclose(self) -> None:
        await self._client.aclose()


def resolve(settings: Settings, provider: str, base_url: str = "", model: str = "") -> Settings:
    """관리자가 고른 대화 모델(settings.json)을 .env 설정 위에 얹는다"""
    provider = provider or settings.llm_provider
    base = (base_url or DEFAULT_URLS.get(provider) or settings.llm_base_url).rstrip("/")
    return settings.model_copy(update={
        "llm_provider": provider, "llm_base_url": base, "llm_model": model or settings.llm_model,
        "llm_autoload": settings.llm_autoload or provider == "mlx",
    })


async def list_models(provider: str, base_url: str) -> List[Dict[str, Any]]:
    """그 서버에 있는 대화 모델 목록 [{id, loaded}] (관리자 화면의 고르기 칸). 연결이 안 되면 예외"""
    base = (base_url or DEFAULT_URLS.get(provider, "")).rstrip("/")
    async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as c:
        if provider == "ollama":
            root = base[:-3] if base.endswith("/v1") else base
            r = await c.get(f"{root}/api/tags")
            r.raise_for_status()
            return [{"id": m["name"], "loaded": None} for m in r.json().get("models", [])]
        r = await c.get(f"{base}/models")
        r.raise_for_status()
        out = []
        for m in r.json().get("data", []):
            caps = m.get("capabilities")
            if caps is not None and "chat" not in caps:
                continue                                 # mlx-serve 의 그림·목소리 모델은 빼고
            out.append({"id": m["id"], "loaded": m.get("loaded")})
        return out


async def close_later(llm: Optional[LLM], delay_s: float = 90.0) -> None:
    """바꾼 뒤 옛 모델 연결을 닫는다. 하던 답은 끝나도록 조금 기다린다"""
    import asyncio
    await asyncio.sleep(delay_s)
    close = getattr(llm, "aclose", None)
    if close:
        await close()


def make_llm(settings: Settings) -> LLM:
    if settings.llm_provider in ("openai", "mlx"):
        return OpenAICompatLLM(settings)
    if settings.llm_provider == "ollama":
        return OllamaLLM(settings)
    return MockLLM(settings.llm_mock_delay_s)
