import * as THREE from "three";
import type { RibbonState } from "../protocol";
import type { NavGrid, P2 } from "../world/nav";
import type { ArtSpot } from "../world/room";
import { toFloor } from "../world/types";
import type { Ribbon3D } from "./ribbon3d";

export interface BrainOptions {
  wander: boolean;
  returnAfterS: number;
}

type Mode =
  | { kind: "idle"; until: number }          // 서서 쉬기
  | { kind: "walk" }                         // 돌아다니는 중 (목적지로)
  | { kind: "called" }                       // 불려서 대화 중 (또는 오는 중)
  | { kind: "linger"; until: number };       // 대화 끝나고 잠깐 머무르기

/**
 * 리본이 행동: 평소엔 맵을 자유롭게 돌아다니고(가구 사이, 그림 구경), 부르면(ribbon.state 가 idle 이 아니게 되면)
 * 그 자리에서 멈춰 TV 쪽으로 돌아 손을 흔들고, "부르면 오는 자리"(layout.doll_spot)로 걸어온다.
 * 대화가 끝나고 returnAfterS 가 지나면 다시 돌아다닌다.
 */
export class RibbonBrain {
  private mode: Mode = { kind: "idle", until: 0 };
  private state: RibbonState = "idle";
  private lastGreet = -1e9;
  private clock = 0;
  private gazeUntil = 0;
  nav: NavGrid | null = null;
  home: P2 = { x: 0, y: 0 };
  arts: ArtSpot[] = [];
  opts: BrainOptions = { wander: true, returnAfterS: 8 };
  /** 카메라(=TV 앞 아이들) 쪽. 매 프레임 index.ts 가 넣어 준다 */
  viewer = new THREE.Vector3();
  /** 카메라 폰이 본 얼굴 쪽 (없으면 null) */
  faceTarget: THREE.Vector3 | null = null;

  constructor(private body: Ribbon3D) {}

  /** 길찾기 격자가 바뀌었을 때. toHome 이면 "부르면 오는 자리"에, 아니면 막힌 곳에 있을 때만 가까운 빈 곳으로 */
  reset(toHome: boolean): void {
    if (!this.nav) return;
    const here = toHome ? this.home : this.body.pos;
    const p = this.nav.nearestFree(here) ?? here;
    if (toHome || !this.nav.isFree(here)) this.body.place(p, 0);
    this.body.stop();
    this.mode = this.called ? { kind: "called" } : { kind: "idle", until: this.clock + 1 };
    if (this.called) this.comeHome();
  }

  private get called(): boolean { return this.state !== "idle"; }

  setState(s: RibbonState): void {
    const was = this.state;
    this.state = s;
    this.body.setState(s);
    if (s !== "idle" && was === "idle") this.onCalled();
    if (s === "idle" && was !== "idle") this.mode = { kind: "linger", until: this.clock + this.opts.returnAfterS };
  }

  private onCalled(): void {
    this.mode = { kind: "called" };
    this.body.stop();
    this.faceViewer();
    const greet = this.clock - this.lastGreet > 25;
    const go = () => { if (this.mode.kind === "called") this.comeHome(); };
    if (greet && this.state === "listening") {
      this.lastGreet = this.clock;
      // 돌아서는 시간을 조금 주고 손 흔들기
      setTimeout(() => this.body.greet(go), 250);
    } else {
      go();
    }
  }

  private comeHome(): void {
    if (!this.nav) return;
    const me = this.body.pos;
    const home = this.nav.nearestFree(this.home) ?? this.home;
    if (Math.hypot(home.x - me.x, home.y - me.y) < 0.6) { this.faceViewer(); return; }
    const path = this.nav.findPath(me, home);
    if (!path) { this.faceViewer(); return; }
    this.body.walkPath(path, () => this.faceViewer());
  }

  private faceViewer(): void {
    this.body.facePoint(toFloor(this.viewer));
  }

  update(dt: number): void {
    this.clock += dt;
    const m = this.mode;
    const now = this.clock;

    // 고개
    if (m.kind === "called" || m.kind === "linger") {
      this.body.lookAt(this.faceTarget ?? this.viewer);
    } else if (now > this.gazeUntil) {
      this.gazeUntil = now + 1.5 + Math.random() * 3;
      this.body.lookAt(this.idleGaze());
    }

    switch (m.kind) {
      case "called":
        if (!this.body.moving && !this.body.busy && Math.random() < dt * 0.5) this.faceViewer();
        break;
      case "linger":
        if (now > m.until) this.mode = { kind: "idle", until: now + 0.5 };
        break;
      case "walk":
        if (!this.body.moving) this.mode = { kind: "idle", until: now + 2 + Math.random() * 5 };
        break;
      case "idle":
        if (now > m.until && !this.body.busy) this.nextActivity();
        break;
    }
    this.body.update(dt);
  }

  private idleGaze(): THREE.Vector3 | null {
    const r = Math.random();
    if (r < 0.3) return this.viewer;
    if (r < 0.5) return null;
    const me = this.body.root.position;
    const a = Math.random() * Math.PI * 2;
    return new THREE.Vector3(me.x + Math.sin(a) * 4, me.y + this.body.height * (0.3 + Math.random() * 0.8), me.z + Math.cos(a) * 4);
  }

  /** 가만히 있다가 다음에 할 일 */
  private nextActivity(): void {
    const nav = this.nav;
    if (!nav || !this.opts.wander) {
      // 돌아다니기가 꺼져 있으면 자리에서 TV 를 본다
      if (nav && !this.body.moving) this.comeHome();
      this.mode = { kind: "idle", until: this.clock + 6 };
      return;
    }
    const r = Math.random();
    if (r < 0.1 && this.clock - this.lastGreet > 30) {
      // 가끔 TV 쪽으로 손 흔들기
      this.faceViewer();
      this.lastGreet = this.clock;
      setTimeout(() => this.body.greet(), 400);
      this.mode = { kind: "idle", until: this.clock + 5 };
      return;
    }
    if (r < 0.4 && this.arts.length && this.visitArt()) return;
    const me = this.body.pos;
    const dest = nav.randomFree((p) => Math.hypot(p.x - me.x, p.y - me.y) > 2.5);
    const path = dest && nav.findPath(me, dest);
    if (!path) { this.mode = { kind: "idle", until: this.clock + 2 }; return; }
    this.body.walkPath(path, () => {
      if (Math.random() < 0.35) this.faceViewer();
    });
    this.mode = { kind: "walk" };
  }

  /** 걸린 그림 앞에 가서 구경하기 */
  private visitArt(): boolean {
    const nav = this.nav!;
    const art = this.arts[Math.floor(Math.random() * this.arts.length)];
    const n = new THREE.Vector3(art.normal.x, 0, art.normal.z).normalize();
    for (const d of [1.8, 2.4, 3.0]) {
      const stand = toFloor(art.center.clone().setY(0).addScaledVector(n, d));
      if (!nav.isFree(stand)) continue;
      const path = nav.findPath(this.body.pos, stand);
      if (!path) continue;
      this.body.walkPath(path, () => {
        this.body.facePoint(toFloor(art.center));
        this.body.lookAt(art.center);
        this.gazeUntil = this.clock + 4;
      });
      this.mode = { kind: "walk" };
      return true;
    }
    return false;
  }
}
