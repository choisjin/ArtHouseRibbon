"""관리자 페이지에서 바꾸는 런타임 설정. data/settings.json 에 저장된다.

.env(Settings) 는 서버 기동 설정(포트, 제공자 종류)이고,
여기(RibbonConfig) 는 운영 중 바꾸는 값(목소리, 성격, 겉모습, 돌아다니기)이다.
대화 모델(LLMConfig)도 여기서 바꾼다. 처음엔 .env 값으로 채우고, 그 뒤로는 여기 값이 .env 보다 앞선다.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Optional

from pydantic import BaseModel, Field


class RibbonLook(BaseModel):
    """3D 인형 겉모습. 색은 재질 기본색을 바꾼다. 고를 수 있는 옷은 캐릭터마다 다르다
    (client/src/world/doll.ts CHARACTERS: 리본이 onepiece|twopiece, 올리·서율 apron|tee)"""
    outfit: str = "onepiece"
    hair: str = "#f48a9e"
    bow: str = "#de2834"
    dress: str = "#80d6be"       # 원피스 / 주름치마
    blouse: str = "#ffe896"      # 투피스 블라우스


class RibbonConfig(BaseModel):
    name: str = "리본"
    voice: str = "F1"            # ribbon/voices.py 의 id (기본 F1~F5, M1~M5 또는 섞은 조합 "YG12-2" 등)
    speed: float = 1.05          # 0.7 ~ 2.0
    steps: int = 8               # 5 ~ 12
    pitch: float = 0.0           # 반음 단위 -6 ~ +8. 어린아이 느낌은 +3 ~ +5
    max_sentences: int = 2
    persona_extra: str = ""      # 시스템 프롬프트 뒤에 붙는 추가 지시문
    ack_enabled: bool = False    # 인식 직후 "응!" 같은 짧은 즉시 반응 (말이 많아져서 기본은 끔)
    listen_cue: str = "sound"    # 부르면: sound = "띵" 소리만 (바로 말할 수 있게) | voice = "응 ○○야, 말해봐."
    end_silence_ms: int = 1300   # 이만큼 조용하면 아이 말이 끝난 것으로 본다. 아이들은 말 중간에 오래 쉰다
    dialogue_style: int = 2      # 2 = 놀이 상대 방식(2026-09-20). 예전 설정 파일을 한 번 옮길 때 쓴다
    memory_enabled: bool = True  # 아이가 지적·금지한 것을 약속으로 기억해 다음 대화에 지킨다 (memory.py)
    memory_max_per_kid: int = 20 # 아이 한 명당 약속 수 (넘치면 오래된 것부터 뺀다)
    button_window_s: float = 6.0 # 호출 버튼을 누른 뒤 이 시간 안에 먼저 말한 아이가 부른 아이
    pokedex_enabled: bool = True # 아이 말에 포켓몬이 나오면 도감을 참고해 답한다 (knowledge/pokedex.py)
    game_max_id: int = 1025      # 포켓몬 맞추기에 나오는 포켓몬: 도감 1번 ~ 이 번호 (1025 = 전부, 151 = 1세대)
    game_range_v: int = 2        # 2 = 기본 범위를 전체로 바꾼 뒤 (2026-09-20). 예전 기본값 151 을 한 번 옮길 때 쓴다
    save_recordings: bool = False  # 인식 개선용으로 아이 말 녹음을 data/recordings/ 에 저장 (tools/stt_eval.py)
    # 입력 방식: button = 버튼(또는 대시보드 호출)을 누른 뒤 말 한 번만 받는다. 이어 말하기·말로 깨우기·끼어들기 없음
    #           auto   = 대답 뒤 이어 말하기, 말소리로 깨우기(energy), 끼어들기까지
    input_mode: str = "button"
    barge_in: bool = True        # 리본이가 말하는 중에 아이가 말하면 멈추고 그 말을 받는다 (auto 일 때만, audio/bargein.py)
    barge_in_rms: float = 0.06   # 끼어들기 소리 크기 기준. 로그의 "리본이 목소리가 마이크에 들어온 크기" 보다 넉넉히 크게
    filler_enabled: bool = True  # 답이 늦으면 "음..." 추임새
    filler_delay_s: float = 1.5  # 반응이 끝난 뒤 이만큼 조용하면 첫 추임새
    filler_interval_s: float = 4.0  # 그 뒤 추임새 간격
    look: RibbonLook = Field(default_factory=RibbonLook)
    character: str = "ribbon"    # TV 에 나오는 캐릭터: ribbon (여자) | ollie (남자) | seoyul (여자)
    friend: str = ""             # 같이 나오는 친구 캐릭터 (빈 값이면 혼자). 친구는 부르지 않아도 알아서 돌아다닌다
    # 맵에서 돌아다니기
    wander: bool = True          # 끄면 "부르면 오는 자리"에 서 있는다
    walk_speed: float = 1.0      # 배율 (1 = 초속 약 0.5m)
    return_after_s: float = 8.0  # 대화가 끝나고 이만큼 지나면 다시 돌아다닌다


class CharacterProfile(BaseModel):
    """캐릭터 한 명의 프로필 (관리자 '캐릭터' 탭). 주인공이 된 캐릭터의 값이 RibbonConfig 로 복사돼 대화·TV 에 쓰인다"""
    name: str = "리본"
    personality: str = ""        # 성격·말투 (시스템 프롬프트 뒤에 붙는다 = RibbonConfig.persona_extra)
    intro: str = ""              # 한 줄 소개 (프로필 카드용)
    voice: str = "F1"
    speed: float = 1.05
    steps: int = 8
    pitch: float = 0.0
    look: RibbonLook = Field(default_factory=RibbonLook)


#: 처음 쓸 때의 캐릭터별 기본 프로필 (client/src/world/doll.ts CHARACTERS 와 같은 id)
DEFAULT_PROFILES: Dict[str, Dict] = {
    "ribbon": {"name": "리본", "intro": "TV 안에 사는 명랑한 미술 친구",
               "personality": "밝고 호기심이 많다. 아이 그림에서 색과 모양을 먼저 알아봐 준다.", "voice": "F1",
               "look": {"outfit": "onepiece"}},
    "ollie": {"name": "올리", "intro": "앞치마를 두른 차분한 남자 친구",
              "personality": "차분하고 다정하다. 천천히 말하고 아이 이야기를 끝까지 들어 준다.", "voice": "M1",
              "look": {"outfit": "apron"}},
    "seoyul": {"name": "서율", "intro": "양갈래 머리의 씩씩한 여자 친구",
               "personality": "씩씩하고 장난스럽다. 새로운 그림 아이디어를 같이 떠올리는 걸 좋아한다.", "voice": "F2",
               "look": {"outfit": "apron"}},
}

#: 주인공 프로필에서 RibbonConfig 로 복사하는 값 (프로필 키 -> RibbonConfig 키)
_PROFILE_TO_RIBBON = {"name": "name", "personality": "persona_extra", "voice": "voice", "speed": "speed",
                      "steps": "steps", "pitch": "pitch", "look": "look"}


class LLMConfig(BaseModel):
    """대화 모델 (관리자 '설정' 탭). 바꾸면 서버를 다시 켜지 않아도 다음 답부터 쓴다"""
    provider: str = "mlx"        # mlx (맥미니 mlx-serve) | ollama | openai (기타 OpenAI 호환) | mock (시험용)
    base_url: str = ""           # 비우면 제공자 기본 주소 (providers/llm.py DEFAULT_URLS)
    model: str = ""


class MusicConfig(BaseModel):
    """Spotify (관리자 '설정' 탭 → 음악). 앱 정보·토큰은 여기 두지 않는다 (data/spotify_auth.json, music.py)"""
    enabled: bool = False        # 리본이에게 말로 음악을 부탁할 수 있다 (music_intent.py)
    output: str = "tv"           # 재생할 곳: tv = TV 화면 | admin = 관리자 페이지를 연 컴퓨터(맥미니)
    playlist_id: str = ""        # "내 목록 틀어줘" · 넣기 · 빼기 목록 (비우면 내가 만든 첫 목록)
    playlist_title: str = ""     # 화면 표시용
    volume: int = 60             # 0 ~ 100. 리본이 목소리보다 작게


class AppConfig(BaseModel):
    ribbon: RibbonConfig = Field(default_factory=RibbonConfig)
    characters: Dict[str, CharacterProfile] = Field(default_factory=dict)
    llm: Optional[LLMConfig] = None
    music: MusicConfig = Field(default_factory=MusicConfig)


class ConfigStore:
    def __init__(self, path: Path):
        self.path = path
        self.config = AppConfig()
        self._llm_from_env = False   # 대화 모델이 관리자가 고른 게 아니라 .env 기본값인가
        self.load()

    def load(self) -> AppConfig:
        raw: Dict = {}
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                self.config = AppConfig(**raw)
            except Exception:  # noqa: BLE001 - 깨진 파일이면 기본값으로
                raw, self.config = {}, AppConfig()
        if raw.get("ribbon") and "dialogue_style" not in raw["ribbon"]:
            # 놀이 상대 방식으로 바꾸기 전 설정: 즉시 반응 끄고 짧게 (관리자 화면에서 다시 켤 수 있다)
            rc = self.config.ribbon
            rc.ack_enabled = False
            rc.max_sentences = min(rc.max_sentences, 2)
            rc.dialogue_style = 2
        if raw.get("ribbon") and "game_range_v" not in raw["ribbon"]:
            # 문제 범위를 전체로 바꾸기 전 설정: 예전 기본값(151) 그대로면 전체로 (관리자가 고른 다른 값은 그대로)
            rc = self.config.ribbon
            if rc.game_max_id == 151:
                rc.game_max_id = 1025
            rc.game_range_v = 2
        self._seed_profiles(had_profiles=bool(raw.get("characters")))
        self._sync_main()
        return self.config

    def _seed_profiles(self, had_profiles: bool) -> None:
        """프로필이 없던 예전 설정이면 지금 주인공 값(이름·목소리·성격·겉모습)을 그 캐릭터 프로필로 옮긴다"""
        rc = self.config.ribbon
        chars = self.config.characters
        if not had_profiles and rc.character not in chars:
            base = DEFAULT_PROFILES.get(rc.character, {})
            prof = {p: getattr(rc, r) for p, r in _PROFILE_TO_RIBBON.items()}
            prof["personality"] = prof["personality"] or base.get("personality", "")   # 비어 있었으면 기본 성격
            chars[rc.character] = CharacterProfile(**prof, intro=base.get("intro", ""))
        for cid, d in DEFAULT_PROFILES.items():
            chars.setdefault(cid, CharacterProfile(**d))

    def profile(self, cid: str) -> CharacterProfile:
        chars = self.config.characters
        if cid not in chars:
            chars[cid] = CharacterProfile(**DEFAULT_PROFILES.get(cid, {"name": cid}))
        return chars[cid]

    def _sync_main(self) -> None:
        """주인공 프로필을 RibbonConfig 의 이름·목소리·성격·겉모습으로 복사 (대화·TTS·TV 는 RibbonConfig 만 본다)"""
        rc = self.config.ribbon
        p = self.profile(rc.character)
        merged = rc.model_dump()
        merged.update({r: getattr(p, k).model_dump() if k == "look" else getattr(p, k)
                       for k, r in _PROFILE_TO_RIBBON.items()})
        self.config.ribbon = RibbonConfig(**merged)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = self.config.model_dump()
        if self._llm_from_env:
            data["llm"] = None     # .env 로 채운 기본값은 파일에 굳히지 않는다 (.env 를 바꾸면 따라가게)
        self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def update_ribbon(self, data: Dict) -> RibbonConfig:
        """공통 설정(주인공·친구·대화·움직임). 이름·목소리 등 프로필 값이 오면 주인공 프로필에 적는다"""
        merged = self.config.ribbon.model_dump()
        merged.update({k: v for k, v in data.items() if v is not None})
        self.config.ribbon = RibbonConfig(**merged)
        rc = self.config.ribbon
        prof = {k: data[r] for k, r in _PROFILE_TO_RIBBON.items() if data.get(r) is not None}
        if prof:
            self.update_character(rc.character, prof, save=False)
        self._sync_main()
        self.save()
        return self.config.ribbon

    def seed_llm(self, provider: str, base_url: str, model: str) -> LLMConfig:
        """관리자가 대화 모델을 고른 적이 없으면 .env 값으로 채운다 (파일에는 고를 때 적는다)"""
        if self.config.llm is None:
            self.config.llm = LLMConfig(provider=provider, base_url=base_url, model=model)
            self._llm_from_env = True
        return self.config.llm

    def update_llm(self, data: Dict) -> LLMConfig:
        merged = (self.config.llm or LLMConfig()).model_dump()
        merged.update({k: str(v).strip() for k, v in data.items() if v is not None and k in LLMConfig.model_fields})
        self.config.llm = LLMConfig(**merged)
        self._llm_from_env = False   # 관리자가 골랐다: 이제부터 .env 보다 앞선다
        self.save()
        return self.config.llm

    def update_music(self, data: Dict) -> MusicConfig:
        merged = self.config.music.model_dump()
        merged.update({k: v for k, v in data.items() if v is not None and k in MusicConfig.model_fields})
        if merged["output"] not in ("tv", "admin"):
            raise ValueError(f"재생할 곳이 잘못됐습니다: {merged['output']}")
        merged["volume"] = max(0, min(100, int(merged["volume"])))
        self.config.music = MusicConfig(**merged)
        self.save()
        return self.config.music

    def update_character(self, cid: str, data: Dict, save: bool = True) -> CharacterProfile:
        merged = self.profile(cid).model_dump()
        merged.update({k: v for k, v in data.items() if v is not None and k in CharacterProfile.model_fields})
        self.config.characters[cid] = CharacterProfile(**merged)
        if save:
            self._sync_main()
            self.save()
        return self.config.characters[cid]
