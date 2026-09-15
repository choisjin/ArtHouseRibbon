"""환경 변수(.env) 기반 설정. 접두어 RIBBON_"""
from __future__ import annotations

from pathlib import Path
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="RIBBON_", env_file=".env", extra="ignore")

    host: str = "0.0.0.0"
    port: int = 8765

    stt_provider: str = "mock"          # mock | faster_whisper | mlx_whisper
    llm_provider: str = "mock"          # mock | openai
    tts_provider: str = "browser"       # browser | mac_say
    wakeword_provider: str = "mock"     # mock | openwakeword

    llm_base_url: str = "http://localhost:11434/v1"
    llm_model: str = "qwen3:30b-a3b"
    llm_api_key: str = "ollama"
    llm_max_tokens: int = 200

    stt_model: str = "large-v3-turbo"
    stt_language: str = "ko"

    wake_phrase: str = "리본아"
    wakeword_model_path: str = ""
    wakeword_threshold: float = 0.5
    cancel_phrases: List[str] = ["내 말 취소", "내말 취소", "취소할게", "취소"]

    channels: int = 4
    sample_rate: int = 16000
    vad_rms_threshold: float = 0.015
    vad_silence_ms: int = 800
    max_utterance_s: int = 15
    follow_up_window_s: float = 6.0

    waiting_timeout_s: float = 20.0
    turn_idle_timeout_s: float = 8.0

    kids_file: str = "../data/kids.json"
    client_dist: str = "../client/dist"

    def kids_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.kids_file).resolve()

    def client_dist_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.client_dist).resolve()


settings = Settings()
