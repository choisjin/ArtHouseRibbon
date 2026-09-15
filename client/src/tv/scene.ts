import { Application, Container, Graphics } from "pixi.js";

/**
 * 일점 투시(정면 원근) 픽셀 룸.
 * 내부 해상도 384x216 으로 그리고 정수 배율로 확대한다 (FHD TV 에서 5배).
 *
 * 좌표계
 * - "뒷벽 평면" 좌표 (bx, by): 뒷벽 사각형이 화면에서 차지하는 픽셀 좌표 (BACK 상수)
 * - t: 깊이. 0 = 뒷벽, 1 = 화면 앞면(관객 쪽). 커질수록 앞으로 나와 크게 보인다
 * - 바닥 위의 점은 (bx, t) 로 표현하고 by 는 항상 바닥선(BACK.y1)
 */
export const VIEW_W = 384;
export const VIEW_H = 216;
export const VP = { x: 192, y: 92 };                    // 소실점
export const BACK = { x0: 108, y0: 38, x1: 276, y1: 132 }; // 뒷벽 사각형
const S_FRONT = VIEW_W / (BACK.x1 - BACK.x0);            // 앞면 배율 (뒷벽 폭 -> 화면 폭)

export interface ScreenPoint { x: number; y: number; s: number }
export interface FloorPos { bx: number; t: number }

export function scaleAt(t: number): number {
  return 1 + t * (S_FRONT - 1);
}

/** 뒷벽 평면 좌표를 깊이 t 에서 화면 좌표로 투영 */
export function project(bx: number, by: number, t: number): ScreenPoint {
  const s = scaleAt(t);
  return { x: VP.x + (bx - VP.x) * s, y: VP.y + (by - VP.y) * s, s };
}

/** 바닥 위 점 (bx, t) 의 화면 좌표 */
export function floorPoint(p: FloorPos): ScreenPoint {
  return project(p.bx, BACK.y1, p.t);
}

export interface Projector { toScreen(p: FloorPos): ScreenPoint }
export const roomProjector: Projector = { toScreen: floorPoint };

type Poly = number[];
const quad = (a: ScreenPoint, b: ScreenPoint, c: ScreenPoint, d: ScreenPoint): Poly => [a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y];

export class RoomScene {
  readonly app = new Application();
  readonly root = new Container();
  readonly back = new Container();      // 벽, 창, 문, 액자, 선반 (시차: 아주 조금)
  readonly floor = new Container();
  readonly world = new Container();     // 테이블, 아바타, 리본이 (y 정렬)
  readonly front = new Container();
  private parallax = 0;

  /** 아이 자리 (테이블 뒤에 나란히) */
  readonly seats: FloorPos[] = [{ bx: 128, t: 0.3 }, { bx: 170, t: 0.3 }, { bx: 214, t: 0.3 }, { bx: 256, t: 0.3 }];
  /** 뒷벽 문 앞 (입장/퇴장 지점) */
  readonly door: FloorPos = { bx: 249, t: 0.02 };
  /** 리본이 자리: 앞쪽 오른쪽 */
  readonly ribbonSpot: FloorPos = { bx: 252, t: 0.62 };
  /** 캐릭터 기본 배율 (뒷벽 기준). 깊이 배율과 곱해진다 */
  readonly avatarBase = 1.5;
  readonly ribbonBase = 0.85;

  async init(parent: HTMLElement): Promise<void> {
    await this.app.init({ background: 0x0e0b16, resizeTo: window, antialias: false, resolution: 1, roundPixels: true });
    parent.appendChild(this.app.canvas);
    this.world.sortableChildren = true;
    this.root.addChild(this.back, this.floor, this.world, this.front);
    this.app.stage.addChild(this.root);
    this.drawRoom();
    this.layout();
    window.addEventListener("resize", () => this.layout());
    this.app.ticker.add(() => {
      const px = Math.round(this.parallax * 2);
      this.back.x = -px;
      this.floor.x = -px;
      for (const c of this.world.children) c.zIndex = c.y;
    });
  }

  setParallax(v: number): void { this.parallax = Math.max(-1, Math.min(1, v)); }

  private layout(): void {
    const s = Math.max(1, Math.floor(Math.min(window.innerWidth / VIEW_W, window.innerHeight / VIEW_H)));
    this.root.scale.set(s);
    this.root.x = Math.floor((window.innerWidth - VIEW_W * s) / 2);
    this.root.y = Math.floor((window.innerHeight - VIEW_H * s) / 2);
  }

  private drawRoom(): void {
    const g = new Graphics();
    const { x0, y0, x1, y1 } = BACK;
    const FAR = 2.2; // 벽/바닥을 화면 밖까지 늘리는 깊이

    // ---- 천장 ----
    g.poly(quad(project(x0, y0, 0), project(x1, y0, 0), project(x1, y0, FAR), project(x0, y0, FAR))).fill(0xf6f1e6);
    // 천장 몰딩 선
    for (const t of [0.12, 0.3, 0.55, 0.9]) {
      const a = project(x0, y0, t), b = project(x1, y0, t);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1, color: 0xe6dfd0 });
    }

    // ---- 바닥 ----
    g.poly(quad(project(x0, y1, 0), project(x1, y1, 0), project(x1, y1, FAR), project(x0, y1, FAR))).fill(0xeadfc9);
    // 마루 널 (소실점으로 모이는 선)
    for (let bx = x0; bx <= x1; bx += 12) {
      const a = project(bx, y1, 0), b = project(bx, y1, FAR);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1, color: 0xd6c9ab });
    }
    // 가로 이음선 (앞으로 올수록 간격이 넓어짐)
    for (const t of [0.08, 0.2, 0.36, 0.56, 0.8, 1.1, 1.5]) {
      const a = project(x0, y1, t), b = project(x1, y1, t);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1, color: 0xd6c9ab });
    }

    // ---- 왼쪽 벽 (파란 벽 + 걸레받이) ----
    g.poly(quad(project(x0, y0, 0), project(x0, y1, 0), project(x0, y1, FAR), project(x0, y0, FAR))).fill(0x3f8fd6);
    g.poly(quad(project(x0, y0 + 46, 0), project(x0, y1, 0), project(x0, y1, FAR), project(x0, y0 + 46, FAR))).fill(0x3a80c0);
    g.poly(quad(project(x0, y1 - 4, 0), project(x0, y1, 0), project(x0, y1, FAR), project(x0, y1 - 4, FAR))).fill(0x2b5f8f);

    // ---- 오른쪽 벽 (연한 벽 + 창문) ----
    g.poly(quad(project(x1, y0, 0), project(x1, y1, 0), project(x1, y1, FAR), project(x1, y0, FAR))).fill(0xdfe9ef);
    g.poly(quad(project(x1, y1 - 4, 0), project(x1, y1, 0), project(x1, y1, FAR), project(x1, y1 - 4, FAR))).fill(0xb7c6cf);
    const windows: [number, number][] = [[0.12, 0.42], [0.5, 0.82], [0.9, 1.25]];
    for (const [ta, tb] of windows) {
      const wy0 = y0 + 12, wy1 = y1 - 22;
      // 프레임
      g.poly(quad(project(x1, wy0 - 3, ta), project(x1, wy0 - 3, tb), project(x1, wy1 + 3, tb), project(x1, wy1 + 3, ta))).fill(0xffffff);
      // 유리 (위 하늘, 아래 밝은 톤)
      const mid = (wy0 + wy1) / 2;
      g.poly(quad(project(x1, wy0, ta), project(x1, wy0, tb), project(x1, mid, tb), project(x1, mid, ta))).fill(0x8fd0ec);
      g.poly(quad(project(x1, mid, ta), project(x1, mid, tb), project(x1, wy1, tb), project(x1, wy1, ta))).fill(0xb9e4f5);
      // 창살
      const tm = (ta + tb) / 2;
      let a = project(x1, wy0, tm), b = project(x1, wy1, tm);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1, color: 0xffffff });
      a = project(x1, mid, ta); b = project(x1, mid, tb);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1, color: 0xffffff });
      // 창턱
      g.poly(quad(project(x1, wy1 + 3, ta), project(x1, wy1 + 3, tb), project(x1, wy1 + 6, tb), project(x1, wy1 + 6, ta))).fill(0xc9d6de);
    }

    // ---- 뒷벽 ----
    g.rect(x0, y0, x1 - x0, y1 - y0).fill(0xf1eadb);
    g.rect(x0, y1 - 4, x1 - x0, 4).fill(0xc9bda3);       // 걸레받이
    g.rect(x0, y0, x1 - x0, 2).fill(0xe3dccb);           // 천장 몰딩
    // 문 (오른쪽)
    g.rect(236, 60, 28, 72).fill(0x5b3f24);
    g.rect(238, 62, 24, 70).fill(0x8a5a33);
    g.rect(241, 66, 18, 26).fill(0x7a4d2a);
    g.rect(241, 98, 18, 28).fill(0x7a4d2a);
    g.rect(256, 96, 2, 2).fill(0xffd54a);                // 손잡이
    // 갤러리 액자 3개 (작품이 걸릴 자리)
    const frames = [[118, 58], [146, 52], [178, 58]];
    frames.forEach(([fx, fy], i) => {
      g.rect(fx, fy, 22, 18).fill(0xd8cba6);
      g.rect(fx + 2, fy + 2, 18, 14).fill(0xfdfbf5);
      // 안에 그림 느낌 (색 덩어리)
      const pal = [[0xff8a80, 0x80d8ff], [0xffd180, 0xa5d6a7], [0xb39ddb, 0xffab91]][i];
      g.rect(fx + 5, fy + 9, 6, 4).fill(pal[0]);
      g.rect(fx + 11, fy + 5, 5, 8).fill(pal[1]);
    });
    // 시계
    g.rect(210, 50, 12, 12).fill(0x2b2b2b);
    g.rect(211, 51, 10, 10).fill(0xffffff);
    g.rect(215, 53, 2, 4).fill(0x2b2b2b);
    g.rect(216, 56, 3, 2).fill(0x2b2b2b);

    // ---- 왼쪽 벽 선반 (물감·붓) ----
    const sh = { ta: 0.5, tb: 1.05, top: y1 - 34 };
    g.poly(quad(project(x0, sh.top, sh.ta), project(x0, sh.top, sh.tb), project(x0, y1, sh.tb), project(x0, y1, sh.ta))).fill(0xa8672f); // 옆면(벽 붙은 면)
    const depth = 14; // 선반 두께(뒷벽 좌표 단위)
    g.poly(quad(project(x0, sh.top, sh.ta), project(x0 + depth, sh.top, sh.ta), project(x0 + depth, sh.top, sh.tb), project(x0, sh.top, sh.tb))).fill(0xc7823f); // 윗면
    g.poly(quad(project(x0 + depth, sh.top, sh.ta), project(x0 + depth, sh.top, sh.tb), project(x0 + depth, y1, sh.tb), project(x0 + depth, y1, sh.ta))).fill(0xb5723a); // 앞면
    // 칸 나누기
    for (const tt of [0.68, 0.86]) {
      const a = project(x0 + depth, sh.top, tt), b = project(x0 + depth, y1, tt);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1, color: 0x8a5528 });
    }
    const a1 = project(x0 + depth, sh.top + 17, sh.ta), b1 = project(x0 + depth, sh.top + 17, sh.tb);
    g.moveTo(a1.x, a1.y).lineTo(b1.x, b1.y).stroke({ width: 1, color: 0x8a5528 });
    // 물감통들 (윗면 위)
    const pots = [0xff5252, 0xffd740, 0x69f0ae, 0x40c4ff, 0xb388ff];
    pots.forEach((c, i) => {
      const p = project(x0 + 4 + (i % 3) * 3, sh.top, sh.ta + 0.08 + i * 0.1);
      g.rect(Math.round(p.x), Math.round(p.y - 5 * p.s), Math.round(3 * p.s), Math.round(5 * p.s)).fill(c);
    });

    this.back.addChild(g);

    // ---- 가운데 낮은 테이블 (world 에 두어 아바타와 깊이 정렬) ----
    const table = new Graphics();
    const T = { x0: 138, x1: 246, ta: 0.4, tb: 0.66, h: 16 };
    const tl = project(T.x0, y1 - T.h, T.ta), tr = project(T.x1, y1 - T.h, T.ta);
    const fl = project(T.x0, y1 - T.h, T.tb), fr = project(T.x1, y1 - T.h, T.tb);
    table.poly(quad(tl, tr, fr, fl)).fill(0xc48a4a);                       // 상판
    const bl = project(T.x0, y1, T.tb), br = project(T.x1, y1, T.tb);
    table.poly(quad(fl, fr, { ...fr, y: fr.y + 4 * fr.s }, { ...fl, y: fl.y + 4 * fl.s })).fill(0x9c6230); // 상판 앞 두께
    // 다리 4개
    for (const [bx, t] of [[T.x0 + 4, T.ta + 0.03], [T.x1 - 4, T.ta + 0.03], [T.x0 + 4, T.tb - 0.02], [T.x1 - 4, T.tb - 0.02]] as [number, number][]) {
      const top = project(bx, y1 - T.h + 4, t), bot = project(bx, y1, t);
      table.rect(Math.round(top.x - 1.5 * top.s), Math.round(top.y), Math.round(3 * top.s), Math.round(bot.y - top.y)).fill(0x7d4a25);
    }
    void bl; void br;
    // 테이블 위 도화지와 크레파스
    const papers = [[150, 0.46], [178, 0.5], [206, 0.45], [228, 0.52]] as [number, number][];
    papers.forEach(([bx, t], i) => {
      const p = project(bx, y1 - T.h, t);
      table.rect(Math.round(p.x), Math.round(p.y - 1), Math.round(14 * p.s), Math.round(9 * p.s)).fill(0xfffdf7);
      const c = [0xff8a80, 0x80d8ff, 0xa5d6a7, 0xffd180][i];
      table.rect(Math.round(p.x + 3 * p.s), Math.round(p.y + 2 * p.s), Math.round(6 * p.s), Math.round(3 * p.s)).fill(c);
    });
    const cray = project(192, y1 - T.h, 0.6);
    [0xff5252, 0xffd740, 0x40c4ff, 0x69f0ae].forEach((c, i) => {
      table.rect(Math.round(cray.x + i * 3 * cray.s), Math.round(cray.y - 2), Math.round(2 * cray.s), Math.round(6 * cray.s)).fill(c);
    });
    // world 는 매 프레임 c.y 로 zIndex 를 매기므로, 테이블의 y 를 앞선(발 위치) 기준값으로 둔다
    table.y = project(192, y1, (T.ta + T.tb) / 2).y;
    table.pivot.y = table.y;
    this.world.addChild(table);
  }
}
