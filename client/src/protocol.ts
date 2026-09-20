// 서버 ribbon/protocol.py 와 짝을 이루는 타입. 자세한 설명은 docs/PROTOCOL.md

export type RibbonState = "idle" | "listening" | "thinking" | "speaking";
export type TurnState = "waiting" | "active" | "done" | "cancelled" | "expired";
export type ClientRole = "tv" | "entrance" | "camera" | "debug" | "admin" | "editor" | "art" | "mic";

/** 매주 반복되는 정규 수업 (0=월 ... 4=금) */
export interface ClassSlot { day: number; start: string; end: string }

export interface KidInfo {
  id: string;
  name: string;
  age?: number | null;
  mic_channel?: number | null;
  seat?: number | null;
  avatar: Record<string, string>;
  present: boolean;
  /** 리본이가 부르는 이름 (비우면 이름) */
  nickname?: string;
  birthday?: string;     // YYYY-MM-DD
  start_date?: string;   // 등원 시작일
  likes?: string;
  memo?: string;
  schedule?: ClassSlot[];
}

export interface TurnInfo {
  id: string;
  kid_id: string;
  channel: number;
  state: TurnState;
  text: string;
  position: number;
}

export interface RibbonConfig {
  name: string;
  voice: string;
  speed: number;
  steps: number;
  pitch: number;
  max_sentences: number;
  persona_extra: string;
  ack_enabled?: boolean;
  /** 부르면: sound = "띵" 소리만 | voice = "응 ○○야, 말해봐." */
  listen_cue?: "sound" | "voice";
  /** 이만큼(ms) 조용하면 아이 말이 끝난 것으로 본다 */
  end_silence_ms?: number;
  filler_enabled?: boolean;
  /** 아이가 지적·금지한 것을 약속으로 기억 (서버 memory.py) */
  memory_enabled?: boolean;
  memory_max_per_kid?: number;
  /** 호출 버튼을 누른 뒤 이 시간(초) 안에 먼저 말한 아이가 부른 아이 */
  button_window_s?: number;
  /** 아이 말에 포켓몬이 나오면 도감(data/pokedex.json)을 참고해 답한다 */
  pokedex_enabled?: boolean;
  /** 포켓몬 맞추기에 나오는 포켓몬: 도감 1번 ~ 이 번호 */
  game_max_id?: number;
  /** 인식 개선용으로 아이 말 녹음 저장 (data/recordings/, tools/stt_eval.py) */
  save_recordings?: boolean;
  /** 입력 방식: button = 버튼을 누른 뒤 말 한 번만 / auto = 이어 말하기·말로 깨우기·끼어들기 */
  input_mode?: "button" | "auto";
  /** 리본이가 말하는 중에 아이가 말하면 멈추고 그 말을 받는다 (auto 일 때만) */
  barge_in?: boolean;
  /** 끼어들기 소리 크기 기준 (서버 로그의 "리본이 목소리가 마이크에 들어온 크기" 보다 크게) */
  barge_in_rms?: number;
  filler_delay_s?: number;
  filler_interval_s?: number;
  look?: Partial<import("./world/doll").RibbonLook>;
  /** TV 에 나오는 캐릭터 (world/doll.ts CHARACTERS) */
  character?: string;
  /** 같이 나오는 친구 캐릭터. 빈 값이면 혼자 */
  friend?: string;
  /** 맵에서 돌아다니기 (끄면 "부르면 오는 자리"에 서 있다) */
  wander?: boolean;
  walk_speed?: number;
  return_after_s?: number;
}

/** 캐릭터 한 명의 프로필 (서버 settings_store.CharacterProfile). 주인공 프로필이 RibbonConfig 로 복사된다 */
export interface CharacterProfile {
  name: string;
  personality: string;
  intro: string;
  voice: string;
  speed: number;
  steps: number;
  pitch: number;
  look: import("./world/doll").RibbonLook;
}

/** 대화 모델 (관리자 '설정' 탭, 서버 settings_store.LLMConfig) */
export interface LLMConfig {
  provider: "mlx" | "ollama" | "openai" | "mock";
  base_url: string;     // "" = 제공자 기본 주소
  model: string;
}

/** Spotify (관리자 '설정' 탭 → 음악, 서버 settings_store.MusicConfig). 앱 정보·토큰은 여기 없다 */
export interface MusicConfig {
  /** 리본이에게 말로 음악을 부탁할 수 있다 */
  enabled: boolean;
  /** 재생할 곳: tv = TV 화면 / admin = 관리자 페이지를 연 컴퓨터(맥미니) */
  output: "tv" | "admin";
  /** "내 목록 틀어줘" · 넣기 · 빼기 목록 (빈 값 = 내가 만든 첫 목록) */
  playlist_id: string;
  playlist_title: string;
  /** 0 ~ 100 */
  volume: number;
  /** 어느 나라 카탈로그로 찾을지 (KR 이어야 한국 발매판 제목이 나온다) */
  market?: string;
}

export interface AppConfig {
  ribbon: RibbonConfig;
  characters?: Record<string, CharacterProfile>;
  llm?: LLMConfig | null;
  music?: MusicConfig;
  /** TV 에 보여줄 방과 그 배치 (서버 world_store.tv_view) */
  world?: import("./world/types").WorldView;
}

export interface StateMsg {
  type: "state";
  kids: KidInfo[];
  queue: TurnInfo[];
  ribbon: RibbonState;
  target_kid: string | null;
  config?: Partial<AppConfig>;
  /** 관리자가 "호출 무시"를 켰는지 */
  ignore_calls?: boolean;
}

export interface SpeakMsg {
  type: "speak";
  utterance_id: string;
  text: string;
  kid_id: string | null;
  audio_b64: string | null;
  final: boolean;
}

export interface RibbonStateMsg {
  type: "ribbon.state";
  state: RibbonState;
  target_kid: string | null;
}

export interface TranscriptMsg {
  type: "transcript";
  kid_id: string | null;
  channel: number;
  text: string;
  final: boolean;
}

export interface KidPresenceMsg {
  type: "kid.enter" | "kid.leave";
  kid_id: string;
}

export interface FacePosition {
  x: number; // 0~1, 화면 왼쪽이 0
  y: number; // 0~1, 위가 0
  w: number;
  kid_id?: string | null;
}

export interface FacePositionsMsg {
  type: "face.positions";
  faces: FacePosition[];
}

/** 관리자 "중단": TV 는 재생 중인 소리와 남은 문장을 버린다 */
export interface SpeakStopMsg { type: "speak.stop" }

/** 불렀을 때 "듣고 있어" 신호. TV 가 짧은 "띵" 소리를 낸다 */
export interface CueMsg { type: "cue"; kind: "listen"; kid_id: string | null }

/** 지금 말을 받을 수 있나 (버튼 뒤 마이크가 열려 있고 리본이가 말하지 않을 때). TV 오른쪽 위 마이크 표시 */
export interface MicMsg { type: "mic"; on: boolean }

/** DJI 송신기 호출 버튼이 눌렸다. 누가 눌렀는지 몰라서 channels 를 잠깐 듣는다 (관리자 대화 기록) */
export interface ButtonMsg { type: "button"; channels: number[] }

/** 포켓몬 맞추기 게임 고르기 화면: 카드 3장, 고른 것(selected)은 반짝이고 한 번 더 묻는다 */
export interface GameMenuView {
  kind: "menu";
  selected: GameMode | null;
  /** thumb: MLX 로 만든 게임 표지 (없으면 null), art: 표지에 올릴 포켓몬 공식 그림 */
  items: { mode: GameMode; num: number; title: string; sub: string; thumb: string | null; art: string }[];
}
export type GameMode = "describe" | "image" | "peek";

/** 포켓몬 맞추기 게임 화면 (서버 games/pokemon_quiz.PokemonQuiz.view). null 이면 게임 없음 */
export type GameView = GameMenuView | GamePlayView;
export interface GamePlayView {
  kind: "play";
  mode: GameMode;
  image: string | null;          // 보일 그림 (설명 듣고 맞추기는 맞추기 전까지 null)
  grid: number;                  // 조금 보고 맞추기의 칸 수 (grid x grid)
  shown: number[] | null;        // 조금 보고 맞추기에서 보이는 칸 (null = 다 보임)
  board: { c: string; k: "letter" | "cho" | "blank" }[];   // 이름판 (글자 수를 알려 주기 전엔 빈 배열)
  solved: boolean;
  answer: string | null;
  types: string[];
}
export interface GameMsg { type: "game"; view: GameView | null }

/** 리본이가 기억하는 약속 (서버 memory.Rule). kid_id 가 null 이면 모든 아이 공통 */
export interface MemoryRule { id: string; text: string; kid_id: string | null; source: string; created: string; by: "auto" | "admin" }

/** 대화 중 아이의 지적·금지로 약속이 생기거나 없어졌을 때 (관리자 화면) */
export interface MemoryChangedMsg { type: "memory.changed"; kid_id: string; added: string[]; removed: string[] }

/** 관리자 조작에 대한 서버 알림 (예: 마이크가 없는 아이를 호출) */
export interface AdminMsg { type: "admin.msg"; text: string; error?: boolean }

// ---- TV 소리 출력 (TV ↔ 관리자 '설정' 탭, 서버 devices.py 가 중계) ----

export interface DeviceRef { deviceId: string; label: string }

export interface OutputStatus {
  /** 장치를 가진 화면 하나 ("브라우저 id/역할") */
  agent: string; role: string; host: string;
  supported: boolean;   // AudioContext.setSinkId (Chrome 110+)
  locked: boolean;      // TV 화면을 한 번 클릭해야 소리가 남
  current: string;      // "" = 시스템 기본 출력
  devices: DeviceRef[];
  msg: string;
}

export interface DevicesMsg { type: "devices"; outputs: OutputStatus[] }

/** 관리자 → (서버) → 그 TV */
export type DeviceControlMsg = { type: "device.control"; agent: string; kind: "output" } & (
  | { action: "set"; deviceId: string }
  | { action: "beep" | "labels" }
);

/** 지금 나오는 곡 (서버 music.track_info) */
export interface MusicTrack {
  uri: string;
  title: string;
  artists: string;
  album_art: string;
  duration_ms: number;
}

/** "플레이리스트 보여줘": TV 에 띄우는 번호 목록 (서버 music_intent.MusicControl.list_view) */
export interface MusicListView {
  /** playlist = 번호를 말하면 목록에서 뺀다 | search = 번호를 말하면 그 노래를 튼다 */
  kind: "playlist" | "search";
  title: string;
  page: number;
  pages: number;
  total: number;
  items: { n: number; title: string; artists: string; art: string }[];
}

export interface MusicListMsg {
  type: "music.list";
  /** null 이면 목록을 내린다 */
  view: MusicListView | null;
}

/** 재생 화면(music/player.ts)이 알린 Spotify 재생 상태를 서버가 모두에게 -> TV 아래 상태바 */
export interface MusicStateMsg {
  type: "music.state";
  playing: boolean;
  track: MusicTrack | null;
  position_ms: number;
  /** 반복: off = 안 함 | context = 목록 반복 | track = 한 곡 반복 */
  repeat?: "off" | "context" | "track";
  shuffle?: boolean;
  /** 무엇을 틀고 있나 (서버 music_intent.source_info) */
  source?: { kind: "search" | "playlist" | "album" | "artist" | "track"; title: string };
}

export type ServerMsg = StateMsg | SpeakMsg | RibbonStateMsg | TranscriptMsg | KidPresenceMsg | FacePositionsMsg
  | SpeakStopMsg | CueMsg | ButtonMsg | MicMsg | GameMsg | MemoryChangedMsg | AdminMsg | DevicesMsg | DeviceControlMsg
  | MusicStateMsg | MusicListMsg;
