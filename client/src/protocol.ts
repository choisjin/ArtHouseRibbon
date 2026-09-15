// 서버 ribbon/protocol.py 와 짝을 이루는 타입. 자세한 설명은 docs/PROTOCOL.md

export type RibbonState = "idle" | "listening" | "thinking" | "speaking";
export type TurnState = "waiting" | "active" | "done" | "cancelled" | "expired";
export type ClientRole = "tv" | "entrance" | "camera" | "debug" | "admin";

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

export interface RibbonColors { body: string; wing: string; bow: string; cheek: string }

export interface RibbonConfig {
  name: string;
  voice: string;
  speed: number;
  steps: number;
  max_sentences: number;
  persona_extra: string;
  colors: RibbonColors;
  sprite_url: string | null;
}

export interface AppConfig {
  ribbon: RibbonConfig;
  avatar_options: { hair: string[] };
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
