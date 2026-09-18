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
  frame?: "canvas" | "black" | "wood" | "white";
  mount: { host: string | null; id: string };
  u?: number;               // m, 면 가운데 기준 좌우
  v?: number;               // m, 그림 중심 높이 (ledge 면은 없음)
  pose?: ArtPose;
}

export interface Layout {
  version?: number;
  room?: string;
  unit_per_m?: number;
  doll_spot: { x: number; y: number };   // 리본이 "부르면 오는 자리"
  items: LayoutItem[];
  storage?: LayoutItem[];
  arts?: LayoutArt[];
}

/** 블렌더로 렌더한 TV 배경 (서버 world_render.py) */
export interface WorldRender {
  bg: string;               // TV 시점 PNG
  env: string | null;       // 리본이 조명용 360° HDR
  layout: Layout | null;    // 렌더에 쓴 배치 (가림막·길찾기는 이것으로)
  rendered_at: number;
  stale: boolean;           // 그 뒤로 배치가 바뀜 (다시 렌더 중이거나 대기)
}

/** state.config.world */
export interface WorldView { room: string; layout: Layout | null; render?: WorldRender | null; rendering?: string | null }

export interface ArtworkInfo { file: string; name: string; width: number; height: number }

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
  junior_chair_red: { height: 0.52, forward: 0.05 },
  junior_chair_black: { height: 0.52, forward: 0.05 },
  windsor_chair: { height: 0.46, forward: 0.07 },
};

/** 바닥에 깔려 위를 지나가도 되는 것 */
export const FLOOR_LAYER = new Set(["rug"]);
