/**
 * 3D 맵 데이터 형식. Character_Creator(블렌더)의 catalog.json / layout.json 과 같다.
 *
 * 좌표: 배치 파일은 블렌더 장면 단위(Z 위, 화면 안쪽 = +Y, TV 카메라는 -Y 쪽). 1m = unit_per_m.
 * three.js 는 Y 위라서 (x, y, z) → (x, z, -y).
 */
import * as THREE from "three";

export interface Rect { x0: number; x1: number; y0: number; y1: number }

export interface MountSpec {
  id: string;
  name: string;
  origin: [number, number, number];
  normal: [number, number, number];
  up: [number, number, number];
  width: number;
  height: number;
  ledge?: boolean;          // 이젤처럼 받침대 위에 올리는 면 (한 점만, 높이 고정)
  hides?: string[];         // 그림을 걸면 숨길 모델 부품 이름 접두사
  default_size?: number;
}

export interface TypeInfo {
  id: string;
  name: string;
  category: string;
  file: string;             // world/ 아래 glb
  back?: [number, number] | null;
  mounts?: MountSpec[];
  bbox: Rect & { z0: number; z1: number };
}

export interface RoomInfo {
  id: string;
  name: string;
  shell: string;
  prefix: string;
  unit_per_m: number;
  width: number;
  height: number;
  depth: number;
  front_y: number;
  back_y: number;
  walls: { left: number; right: number; back: number };
  mounts?: MountSpec[];
  obstacles: (Rect & { name: string })[];
  tv_camera: { x: number; y: number; z: number; hfov_deg: number; res: [number, number] };
}

export interface Catalog {
  rooms: Record<string, RoomInfo>;
  types: TypeInfo[];
  default_layout?: Layout;
  default_layouts?: Record<string, Layout>;
}

export interface LayoutItem { id: string; type: string; x: number; y: number; rot: number }

export interface ArtPose { c: number[]; n: number[]; up: number[] }

export interface LayoutArt {
  id: string;
  image: string;            // "artworks/<파일>"
  width: number;            // m
  aspect: number;           // 세로/가로
  /** 액자 종류 (world/frames.ts 의 FRAME_STYLES id). 블렌더로 굽는 방은 canvas/black/wood/white 만 안다 */
  frame?: string;
  mount: { host: string | null; id: string };
  u?: number;               // m, 면 가운데 기준 좌우
  v?: number;               // m, 그림 중심 높이 (ledge 면은 없음)
  pose?: ArtPose;
  /** 배경을 지운 작품 뒤에 까는 색(없으면 흰색)과 여백 [왼,위,오,아래] (world/artimage.ts). 작품을 편집하면 서버가 맞춰 준다 */
  bg?: string;
  pad?: number[];
  /** 고정: 끌어서 옮기거나 잘못 내리지 않게 잠근 그림 (전시실 꾸미기) */
  pin?: boolean;
  /** 이 그림에 건 이미지 필터와 하이라이트 (world/artfx.ts 의 ArtFx). 없으면 원본 그대로 */
  fx?: Partial<Record<"b" | "c" | "s" | "w" | "sepia" | "glow" | "glowTone" | "glowSize", number>> | null;
}

export interface Layout {
  version?: number;
  room?: string;
  /** 방 모양·벽(그림 거는 면)을 가져올 카탈로그 방. 아이 전시실이 전시장 것을 빌려 쓴다 */
  shell?: string;
  unit_per_m?: number;
  doll_spot: { x: number; y: number };   // 리본이 "부르면 오는 자리"
  items: LayoutItem[];
  storage?: LayoutItem[];
  arts?: LayoutArt[];
  /** 전시실 조명 밝기 (1 = 렌더 그대로, 아이 전시실만) */
  light?: number;
  /** 전시실에 세워 둔 캐릭터 (world/guide.ts). TV 에는 세우지 않는다 (살아 있는 캐릭터가 따로 있다) */
  guide?: { who: string; x: number; y: number; rot: number; pose: string } | null;
  /** 아이 전시실: 몇 실인지 / 모두 몇 실인지 */
  hall?: number;
  halls?: number;
}

/** 시간대(일출·아침·낮·일몰·밤) 하나의 배경 */
export interface RenderPhase {
  bg: string;               // TV 시점 PNG
  env: string | null;       // 리본이 조명용 360° HDR
  /** 둘러보기용 360° 파노라마 (전시장 껍데기를 쓰는 방만, Stage.setLooking) */
  pano?: string | null;
}

/** 블렌더로 렌더한 TV 배경 (서버 world_render.py) */
export interface WorldRender extends RenderPhase {
  /** 걸린 그림이 배경에 찍혀 있지 않고 실시간으로 그려야 하는가 (아이 전시실) */
  arts_live?: boolean;
  /** 시간대별 배경 (없으면 bg/env 하나만 쓴다) */
  phases?: Record<string, RenderPhase>;
  /** [시작 시각(0~23), 시간대 이름] 목록. 시간 순서이고, 첫 시각 전이면 마지막 시간대(밤) */
  schedule?: [number, string][];
  layout: Layout | null;    // 렌더에 쓴 배치 (가림막·길찾기는 이것으로)
  /** 파노라마를 찍은 자리 (블렌더 좌표 x, y, z) */
  pano_pos?: number[] | null;
  rendered_at: number;
  stale: boolean;           // 그 뒤로 배치가 바뀜 (다시 렌더 중이거나 대기)
}

/** 지금 시각에 맞는 배경을 고른다 (시간대별 렌더가 없으면 그대로) */
export function renderNow(r: WorldRender | null | undefined, at = new Date()): WorldRender | null | undefined {
  if (!r?.phases || !r.schedule?.length) return r;
  let name = r.schedule[r.schedule.length - 1][1];     // 첫 시각(일출) 전이면 밤
  for (const [h, n] of r.schedule) if (at.getHours() >= h) name = n;
  const p = r.phases[name];
  return p ? { ...r, bg: p.bg, env: p.env, pano: p.pano } : r;
}

/** state.config.world */
export interface WorldView {
  room: string;
  layout: Layout | null;
  render?: WorldRender | null;
  rendering?: string | null;
  kid_id?: string;              // 아이 전시실이면 그 아이
}

export interface ArtworkInfo { file: string; name: string; width: number; height: number; bg?: string; pad?: number[] }

export const WORLD_BASE = "/world/";

export const b2t = (v: ArrayLike<number>) => new THREE.Vector3(v[0], v[2], -v[1]);
export const toThree = (x: number, y: number, z = 0) => new THREE.Vector3(x, z, -y);
/** three.js 점 → 배치 바닥 좌표 */
export const toFloor = (p: THREE.Vector3) => ({ x: p.x, y: -p.z });
export const rad = THREE.MathUtils.degToRad;

/**
 * 앉을 수 있는 의자: 좌판 높이(m)와 좌판 가운데에서 앞으로 얼마나 나와 앉는지(m).
 * 값은 Character_Creator room_map.py 의 의자 만들기 함수(seat_z)에서 가져왔다.
 * 의자는 back=(0,1) 이라 의자 좌표에서 앞은 -Y 쪽이다.
 */
export const SEATS: Record<string, { height: number; forward: number }> = {
  junior_chair_red: { height: 0.52, forward: 0.09 },
  junior_chair_black: { height: 0.52, forward: 0.09 },
  windsor_chair: { height: 0.46, forward: 0.13 },
};

/** 바닥에 깔려 위를 지나가도 되는 것 */
export const FLOOR_LAYER = new Set(["rug"]);
