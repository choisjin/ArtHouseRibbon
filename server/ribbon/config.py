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
    llm_provider: str = "mock"          # mock | ollama | openai(OpenAI 호환: mlx-lm, vLLM 등)
    tts_provider: str = "browser"       # browser | mac_say | supertonic
    tts_voice: str = "F1"               # supertonic 내장 음성: M1~M5, F1~F5
    tts_speed: float = 1.05             # supertonic 0.7 ~ 2.0
    tts_steps: int = 8                  # supertonic 품질 5(낮음) ~ 12(높음)
    wakeword_provider: str = "mock"     # mock | openwakeword

    llm_base_url: str = "http://localhost:11434/v1"
    llm_model: str = "gemma3:27b"       # 생각(thinking) 모드가 없어 아이 대화에 적합
    llm_api_key: str = "ollama"
    llm_max_tokens: int = 400
    llm_no_think: bool = True           # qwen3 계열의 생각(thinking) 모드 끄기
    llm_mock_delay_s: float = 0.0       # mock LLM 응답 지연 (추임새 동작 확인용)

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
    turn_idle_timeout_s: float = 10.0   # 리본이가 "말해봐"를 끝낸 뒤부터 잰다

    kids_file: str = "../data/kids.json"
    settings_file: str = "../data/settings.json"
    room_file: str = "../data/room.json"
    assets_dir: str = "../data/assets"
    client_dist: str = "../client/dist"

    def kids_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.kids_file).resolve()

    def settings_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.settings_file).resolve()

    def room_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.room_file).resolve()

    def assets_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.assets_dir).resolve()

    def client_dist_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.client_dist).resolve()


settings = Settings()
