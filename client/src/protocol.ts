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
  filler_enabled?: boolean;
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

export interface AppConfig {
  ribbon: RibbonConfig;
  characters?: Record<string, CharacterProfile>;
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

/** 관리자 조작에 대한 서버 알림 (예: 마이크가 없는 아이를 호출) */
export interface AdminMsg { type: "admin.msg"; text: string; error?: boolean }

// ---- 장치 (마이크를 받는 화면·소리를 내는 TV ↔ 관리자 '설정' 탭, 서버 devices.py 가 중계) ----

export interface DeviceRef { deviceId: string; label: string }
/** 고른 마이크: 이 장치의 0번 채널이 논리 채널 몇 번인지 (1세트 0, 2세트 2) */
export interface MicChoice extends DeviceRef { channelOffset: number }

/** 장치를 가진 화면 하나 ("브라우저 id/역할"). role 은 mic(마이크 화면) 또는 tv */
interface AgentInfo { agent: string; role: string; host: string }

export interface MicStatus {
  running: boolean;
  /** 켰지만 브라우저가 소리 입력을 막고 있음 (그 화면을 한 번 클릭해야 함) */
  locked: boolean;
  devices: DeviceRef[];
  selected: MicChoice[];
  opened: { label: string; channelCount: number; channelOffset: number }[];
  levels: number[];
  msg: string;
}

export interface OutputStatus {
  supported: boolean;   // AudioContext.setSinkId (Chrome 110+)
  locked: boolean;      // TV 화면을 한 번 클릭해야 소리가 남
  current: string;      // "" = 시스템 기본 출력
  devices: DeviceRef[];
  msg: string;
}

export interface DevicesMsg { type: "devices"; mics: (MicStatus & AgentInfo)[]; outputs: (OutputStatus & AgentInfo)[] }
export interface DevicesLevelsMsg { type: "devices.levels"; agent: string; levels: number[] }

/** 관리자 → (서버) → 그 화면 */
export type DeviceControlMsg = { type: "device.control"; agent: string } & (
  | { kind: "mic"; action: "start"; devices: MicChoice[] }
  | { kind: "mic"; action: "stop" | "refresh" }
  | { kind: "output"; action: "set"; deviceId: string }
  | { kind: "output"; action: "beep" | "labels" }
);

export type ServerMsg = StateMsg | SpeakMsg | RibbonStateMsg | TranscriptMsg | KidPresenceMsg | FacePositionsMsg
  | SpeakStopMsg | AdminMsg | DevicesMsg | DevicesLevelsMsg | DeviceControlMsg;
