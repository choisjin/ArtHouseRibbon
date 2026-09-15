import type { FloorPos, Perspective } from "./spec";

export interface ScreenPoint { x: number; y: number; s: number }
export interface Projector { toScreen(p: FloorPos): ScreenPoint }

/**
 * 일점 투시 투영. 뒷벽 평면 좌표 (bx, by) 를 깊이 t 에서 화면 좌표로.
 * s(t) = 1 + t * (S_FRONT - 1), S_FRONT = 화면 폭 / 뒷벽 폭 (t=1 에서 뒷벽 폭이 화면 폭이 된다)
 */
export class Projection implements Projector {
  readonly sFront: number;

  constructor(readonly P: Perspective, readonly viewW: number) {
    this.sFront = viewW / (P.back.x1 - P.back.x0);
  }

  scaleAt(t: number): number { return 1 + t * (this.sFront - 1); }

  project(bx: number, by: number, t: number): ScreenPoint {
    const s = this.scaleAt(t);
    return { x: this.P.vp.x + (bx - this.P.vp.x) * s, y: this.P.vp.y + (by - this.P.vp.y) * s, s };
  }

  /** 바닥 위 점의 화면 좌표 (발 위치) */
  floorPoint(p: FloorPos): ScreenPoint { return this.project(p.bx, this.P.back.y1, p.t); }
  toScreen(p: FloorPos): ScreenPoint { return this.floorPoint(p); }

  /** 화면 좌표 -> 바닥 좌표 (관리자 배치 화면의 드래그용). 지평선 위면 null */
  unprojectFloor(x: number, y: number): FloorPos | null {
    const s = (y - this.P.vp.y) / (this.P.back.y1 - this.P.vp.y);
    if (s <= 0.05) return null;
    const t = (s - 1) / (this.sFront - 1);
    const bx = this.P.vp.x + (x - this.P.vp.x) / s;
    return { bx, t: Math.max(-0.2, Math.min(2.5, t)) };
  }
}
