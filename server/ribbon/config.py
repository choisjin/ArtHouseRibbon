"""환경 변수(.env) 기반 설정. 접두어 RIBBON_"""
from __future__ import annotations

from pathlib import Path
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="RIBBON_", env_file=".env", extra="ignore")

    host: str = "0.0.0.0"
    port: int = 8765
    #: 밖에서 들어오는 주소 (Cloudflare Tunnel 등 앞단이 있을 때). 예: https://ribbon.example.com
    #: Spotify 로그인 redirect 와 폰으로 여는 QR 주소에 쓴다. 비우면 이 컴퓨터의 랜 주소를 쓴다
    public_url: str = ""

    stt_provider: str = "mock"          # mock | faster_whisper | mlx_whisper
    # 대화 모델은 관리자 '설정' 탭에서 고른다 (data/settings.json). 여기 값은 처음 한 번 그 칸을 채우는 데만 쓴다
    llm_provider: str = "mock"          # mlx (맥미니 mlx-serve) | ollama | openai(기타 OpenAI 호환) | mock
    tts_provider: str = "browser"       # browser | mac_say | supertonic
    tts_voice: str = "F1"               # supertonic 내장 음성: M1~M5, F1~F5
    tts_speed: float = 1.05             # supertonic 0.7 ~ 2.0
    tts_steps: int = 8                  # supertonic 품질 5(낮음) ~ 12(높음)
    wakeword_provider: str = "mock"     # mock | openwakeword

    llm_base_url: str = ""              # 비우면 제공자 기본 주소 (mlx 11234, ollama 11434)
    llm_model: str = "ddalcu/Qwen3.6-35B-A3B-MLX-Serve-4bit"
    llm_api_key: str = "ollama"
    llm_max_tokens: int = 400
    llm_no_think: bool = True           # qwen3 계열의 생각(thinking) 모드 끄기
    # mlx-serve 처럼 다른 모델(그림·목소리)에 자리를 내주려고 모델을 스스로 내리는 서버: 답하기 전에 /load-model 로 올려 둔다
    llm_autoload: bool = False
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
    # 에코 막기: 리본이가 말하는 동안과 끝난 뒤 echo_tail_ms 동안은 마이크 소리를 버린다.
    # TV 스피커 소리가 마이크(특히 웹캠 마이크)로 다시 들어가 새 질문이 되는 것을 막는다.
    # 대신 리본이가 말하는 중에는 다른 아이의 호출도 듣지 못한다 (목에 거는 마이크만 쓰면 꺼도 된다)
    echo_guard: bool = True
    echo_tail_ms: int = 700
    # 호출 버튼: DJI 수신기 버튼 (audio/button.py). 서버가 수신기 HID 를 독점으로 연다 (pip install hidapi)
    call_button_hid: bool = True

    waiting_timeout_s: float = 20.0
    turn_idle_timeout_s: float = 10.0   # 리본이가 "말해봐"를 끝낸 뒤부터 잰다

    kids_file: str = "../data/kids.json"
    settings_file: str = "../data/settings.json"
    schedule_file: str = "../data/schedule.json"   # 시간표의 하루짜리 변경 (schedule.py)
    memory_file: str = "../data/memory.json"       # 리본이가 기억하는 약속 (memory.py)
    music_auth_file: str = "../data/spotify_auth.json"  # Spotify 앱 정보·토큰 (music.py, git 제외)
    pokedex_file: str = "../data/pokedex.json"     # 포켓몬 도감 (tools/fetch_pokedex.py 로 받는다)
    world_dir: str = "../data/world"          # 방별 가구 배치 (world_store.py)
    artworks_dir: str = "../data/artworks"    # 벽에 거는 그림
    world_catalog: str = "../client/public/world/catalog.json"   # tools/sync_world.py 가 가져온 카탈로그
    blender_exe: str = ""               # 비우면 PATH / /Applications/Blender.app 에서 찾음
    render_auto: bool = True            # 편집기 저장 뒤 TV 배경 자동 렌더
    render_pct: int = 50                # 3840x2160 의 % (50 = 1920x1080)
    render_samples: int = 96
    client_dist: str = "../client/dist"

    def kids_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.kids_file).resolve()

    def settings_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.settings_file).resolve()

    def music_auth_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.music_auth_file).resolve()

    def pokedex_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.pokedex_file).resolve()

    def memory_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.memory_file).resolve()

    def schedule_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.schedule_file).resolve()

    def world_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.world_dir).resolve()

    def artworks_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.artworks_dir).resolve()

    def world_catalog_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.world_catalog).resolve()

    def client_dist_path(self) -> Path:
        return (Path(__file__).resolve().parent.parent / self.client_dist).resolve()


settings = Settings()
