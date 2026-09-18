// 서버 ribbon/protocol.py 와 짝을 이루는 타입. 자세한 설명은 docs/PROTOCOL.md

export type RibbonState = "idle" | "listening" | "thinking" | "speaking";
export type TurnState = "waiting" | "active" | "done" | "cancelled" | "expired";
export type ClientRole = "tv" | "entrance" | "camera" | "debug" | "admin" | "editor" | "art" | "mic";

export interface KidInfo {
  id: string;
  name: string;
  age?: number | null;
  mic_channel?: number | null;
  seat?: number | null;
  avatar: Record<string, string>;
  present: boolean;
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
  /** 맵에서 돌아다니기 (끄면 "부르면 오는 자리"에 서 있다) */
  wander?: boolean;
  walk_speed?: number;
  return_after_s?: number;
}

export interface AppConfig {
  ribbon: RibbonConfig;
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

export type ServerMsg = StateMsg | SpeakMsg | RibbonStateMsg | TranscriptMsg | KidPresenceMsg | FacePositionsMsg;
