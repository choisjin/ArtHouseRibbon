import { Application, Container, Graphics } from "pixi.js";

/**
 * 아이소메트릭 픽셀 룸.
 * 내부 해상도 320x180 으로 그리고 정수 배율로 확대해 도트 느낌을 유지한다.
 * 좌표계: 타일 (i, j) -> 화면 x = (i - j) * TW/2, y = (i + j) * TH/2
 */
export const VIEW_W = 320;
export const VIEW_H = 180;
export const TW = 32;
export const TH = 16;
const COLS = 9;
const ROWS = 7;

export interface IsoPoint { x: number; y: number }

export function isoToScreen(i: number, j: number): IsoPoint {
  return { x: (i - j) * (TW / 2), y: (i + j) * (TH / 2) };
}

export class RoomScene {
  readonly app = new Application();
  readonly root = new Container();      // 배율 적용되는 루트
  readonly back = new Container();      // 벽, 문, 갤러리 (시차: 느림)
  readonly floor = new Container();     // 바닥 타일
  readonly world = new Container();     // 아바타, 리본이, 가구 (y 정렬)
  readonly front = new Container();     // 앞쪽 소품 (시차: 빠름)
  private parallax = 0;                 // -1 ~ 1, 카메라가 본 아이 위치로 미세하게 움직임
  origin: IsoPoint = { x: VIEW_W / 2, y: 44 };
  door: IsoPoint;
  seats: IsoPoint[];
  ribbonSpot: IsoPoint;

  constructor() {
    this.door = this.tile(4, -1);
    this.seats = [this.tile(2, 2), this.tile(5, 2), this.tile(2, 5), this.tile(5, 5)];
    this.ribbonSpot = this.tile(8.3, 5.2); // 앞쪽 오른쪽, 자리와 겹치지 않게
  }

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
      const px = Math.round(this.parallax * 3);
      this.back.x = -px;
      this.front.x = px * 2;
      for (const c of this.world.children) c.zIndex = c.y;
    });
  }

  /** 타일 좌표를 화면 좌표(배율 적용 전)로 */
  tile(i: number, j: number): IsoPoint {
    const p = isoToScreen(i, j);
    return { x: this.origin.x + p.x, y: this.origin.y + p.y };
  }

  setParallax(v: number): void { this.parallax = Math.max(-1, Math.min(1, v)); }

  private layout(): void {
    const s = Math.max(1, Math.floor(Math.min(window.innerWidth / VIEW_W, window.innerHeight / VIEW_H)));
    this.root.scale.set(s);
    this.root.x = Math.floor((window.innerWidth - VIEW_W * s) / 2);
    this.root.y = Math.floor((window.innerHeight - VIEW_H * s) / 2);
  }

  private drawRoom(): void {
    // 뒷벽 두 면
    const wall = new Graphics();
    const o = this.origin;
    const leftTop = isoToScreen(0, 0), rightTop = isoToScreen(COLS, 0), leftBot = isoToScreen(0, ROWS);
    const wallH = 52;
    wall.poly([o.x + leftBot.x, o.y + leftBot.y - wallH, o.x + leftTop.x, o.y + leftTop.y - wallH,
      o.x + leftTop.x, o.y + leftTop.y, o.x + leftBot.x, o.y + leftBot.y]).fill(0x3a2f4f);
    wall.poly([o.x + leftTop.x, o.y + leftTop.y - wallH, o.x + rightTop.x, o.y + rightTop.y - wallH,
      o.x + rightTop.x, o.y + rightTop.y, o.x + leftTop.x, o.y + leftTop.y]).fill(0x4a3d63);
    // 문 (오른쪽 벽)
    const d = this.tile(4, 0);
    wall.poly([d.x - 10, d.y - 5 - 34, d.x + 10, d.y + 5 - 34, d.x + 10, d.y + 5, d.x - 10, d.y - 5]).fill(0x1c1626);
    wall.poly([d.x - 8, d.y - 4 - 30, d.x + 8, d.y + 4 - 30, d.x + 8, d.y + 4, d.x - 8, d.y - 4]).fill(0x7a5a3a);
    // 갤러리 액자 자리 (왼쪽 벽) - 작품이 걸릴 위치
    for (let k = 0; k < 3; k++) {
      const f = this.tile(0, 1.2 + k * 1.8);
      wall.poly([f.x - 7, f.y - 4 - 36, f.x + 7, f.y + 4 - 36, f.x + 7, f.y + 4 - 18, f.x - 7, f.y - 4 - 18]).fill(0xd9cfae);
    }
    this.back.addChild(wall);

    // 바닥 타일
    const fl = new Graphics();
    for (let i = 0; i < COLS; i++) {
      for (let j = 0; j < ROWS; j++) {
        const p = this.tile(i, j);
        const c = (i + j) % 2 === 0 ? 0x8a6d4b : 0x7a5f41;
        fl.poly([p.x, p.y - TH / 2, p.x + TW / 2, p.y, p.x, p.y + TH / 2, p.x - TW / 2, p.y]).fill(c);
      }
    }
    this.floor.addChild(fl);

    // 이젤 (자리마다)
    for (const s of this.seats) {
      const e = new Graphics();
      e.rect(-1, -22, 2, 22).fill(0x6b4a2b);
      e.rect(-7, -20, 14, 12).fill(0xf4f1e6);
      e.rect(-7, -20, 14, 1).fill(0xc9b98a);
      e.x = s.x + 14; e.y = s.y - 2;
      this.world.addChild(e);
    }
  }
}
