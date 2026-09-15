"""LLM 제공자.

- MockLLM: 모델 없이 흐름 확인용 고정 답변
- OpenAICompatLLM: Ollama, mlx-lm server 등 OpenAI 호환 /chat/completions 스트리밍
"""
from __future__ import annotations

import json
from typing import AsyncIterator, Dict, List, Protocol

import httpx

from ..config import Settings

Message = Dict[str, str]


class LLM(Protocol):
    async def stream(self, messages: List[Message]) -> AsyncIterator[str]: ...


class MockLLM:
    async def stream(self, messages: List[Message]) -> AsyncIterator[str]:
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
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=5.0))

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


def make_llm(settings: Settings) -> LLM:
    if settings.llm_provider == "openai":
        return OpenAICompatLLM(settings)
    return MockLLM()
