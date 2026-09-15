import { Application, Container } from "pixi.js";
import { RoomView } from "./room/view";
import { FALLBACK_ROOM, type FloorPos, type RoomSpec } from "./room/spec";
import type { Projector } from "./room/projection";

export type { FloorPos } from "./room/spec";
export type { Projector, ScreenPoint } from "./room/projection";

/**
 * TV 화면: Pixi Application + RoomView + 정수 배율 레이아웃 + 시차.
 * 방의 그림과 위치는 RoomSpec(서버 data/room.json)이 가진다.
 */
export class RoomScene {
  readonly app = new Application();
  readonly root = new Container();
  view: RoomView;
  private roomJson = "";
  private parallax = 0;

  constructor(spec: RoomSpec = FALLBACK_ROOM) {
    this.view = new RoomView(spec);
    this.roomJson = JSON.stringify(spec);
  }

  get viewW(): number { return this.view.spec.view.w; }
  get viewH(): number { return this.view.spec.view.h; }
  get world(): Container { return this.view.world; }
  get seats(): FloorPos[] { return this.view.seats; }
  get door(): FloorPos { return this.view.door; }
  get ribbonSpot(): FloorPos { return this.view.ribbonSpot; }
  get avatarBase(): number { return this.view.avatarBase; }
  get ribbonBase(): number { return this.view.ribbonBase; }
  get projector(): Projector { return { toScreen: (p) => this.view.proj.floorPoint(p) }; }

  async init(parent: HTMLElement): Promise<void> {
    await this.app.init({ background: 0x0e0b16, resizeTo: window, antialias: false, resolution: 1, roundPixels: true });
    parent.appendChild(this.app.canvas);
    this.root.addChild(this.view.back, this.view.floor, this.view.world, this.view.front);
    this.app.stage.addChild(this.root);
    await this.view.setSpec(this.view.spec);
    this.layout();
    window.addEventListener("resize", () => this.layout());
    this.app.ticker.add(() => {
      const px = Math.round(this.parallax * 3);
      this.view.back.x = -px;
      this.view.floor.x = -px;
      for (const c of this.view.world.children) if (!(c as { _noSort?: boolean })._noSort) c.zIndex = c.y;
    });
  }

  /** 서버가 보낸 방 설정이 바뀌었으면 다시 그린다. 바뀌었으면 true */
  async setRoom(spec: RoomSpec): Promise<boolean> {
    const json = JSON.stringify(spec);
    if (json === this.roomJson) return false;
    this.roomJson = json;
    await this.view.setSpec(spec);
    this.layout();
    return true;
  }

  setParallax(v: number): void { this.parallax = Math.max(-1, Math.min(1, v)); }

  private layout(): void {
    const s = Math.max(1, Math.floor(Math.min(window.innerWidth / this.viewW, window.innerHeight / this.viewH)));
    this.root.scale.set(s);
    this.root.x = Math.floor((window.innerWidth - this.viewW * s) / 2);
    this.root.y = Math.floor((window.innerHeight - this.viewH * s) / 2);
  }
}
