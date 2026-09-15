/**
 * 방 구성 데이터 (data/room.json). 그림은 PNG 레이어, 위치는 이 JSON 이 가진다.
 *
 * 좌표계
 * - 화면 좌표: 내부 해상도 view.w x view.h (기본 640x360) 픽셀. 레이어 스프라이트 위치는 화면 좌표(좌상단).
 * - 바닥 좌표 FloorPos {bx, t}: 캐릭터가 서는 위치. bx 는 "뒷벽 평면" x, t 는 깊이(0 = 뒷벽, 1 = 화면 앞면).
 *   perspective(소실점 vp, 뒷벽 사각형 back)로 화면 좌표와 배율이 정해진다. projection.ts 참고.
 */

export interface FloorPos { bx: number; t: number }
export type LayerKind = "back" | "floor" | "world" | "front";

export interface RoomLayer {
  id: string;
  file: string;          // "/room/table.png" 처럼 서버 루트 기준 경로. 관리자 업로드는 "/uploads/..."
  x: number;             // 화면 좌표 좌상단
  y: number;
  layer: LayerKind;      // back: 벽 붙박이 / floor: 러그처럼 항상 발 밑 / world: 아바타와 앞뒤 정렬 / front: 카메라 앞
  sortY?: number;        // world 전용. 이 y(바닥에 닿는 선) 기준으로 아바타와 앞뒤를 가른다. 없으면 스프라이트 아래끝
  scale?: number;        // 기본 1
  flip?: boolean;        // 좌우 반전
  visible?: boolean;     // 기본 true
  label?: string;        // 관리자 페이지 표시 이름
}

export interface Perspective {
  vp: { x: number; y: number };                       // 소실점
  back: { x0: number; y0: number; x1: number; y1: number }; // 뒷벽 사각형 (y1 = 바닥선)
}

export interface RoomSpec {
  version: 2;
  view: { w: number; h: number };
  perspective: Perspective;
  layers: RoomLayer[];                                // 배열 순서 = 같은 레이어 안의 그리기 순서
  anchors: { seats: FloorPos[]; door: FloorPos; ribbon: FloorPos };
  frameSlots: { x: number; y: number; w: number; h: number }[];   // 작품이 걸릴 액자 안쪽 (화면 좌표)
  scale: { avatar: number; ribbon: number };          // 캐릭터 기본 배율 (깊이 배율과 곱함)
}

/** 서버가 room 을 못 주는 동안 쓰는 최소 기본값. 실제 기본값은 data/room.example.json */
export const FALLBACK_ROOM: RoomSpec = {
  version: 2,
  view: { w: 640, h: 360 },
  perspective: { vp: { x: 320, y: 150 }, back: { x0: 172, y0: 60, x1: 470, y1: 228 } },
  layers: [{ id: "bg", file: "/room/bg.png", x: 0, y: 0, layer: "back", label: "배경" }],
  anchors: {
    seats: [{ bx: 205, t: 0.3 }, { bx: 265, t: 0.3 }, { bx: 330, t: 0.3 }, { bx: 395, t: 0.3 }],
    door: { bx: 405, t: 0.02 },
    ribbon: { bx: 440, t: 0.7 },
  },
  frameSlots: [],
  scale: { avatar: 1.0, ribbon: 0.8 },
};
