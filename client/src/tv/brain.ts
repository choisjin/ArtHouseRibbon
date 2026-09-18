import * as THREE from "three";
import type { RibbonState } from "../protocol";
import type { NavGrid, P2 } from "../world/nav";
import type { ArtSpot } from "../world/room";
import { rad, SEATS, toFloor, type LayoutItem } from "../world/types";
import type { Expression } from "./face";
import type { Motion, Ribbon3D } from "./ribbon3d";

export interface BrainOptions {
  wander: boolean;
  returnAfterS: number;
}

type Mode =
  | { kind: "idle"; until: number }          // 서서 쉬기
  | { kind: "walk" }                         // 돌아다니는 중 (목적지로)
  | { kind: "called" }                       // 불려서 대화 중 (또는 오는 중)
  | { kind: "linger"; until: number }        // 대화 끝나고 잠깐 머무르기
  | { kind: "sitting"; until: number }       // 의자에 앉아 쉬는 중
  | { kind: "peek"; until: number };         // 화면 코앞에 붙어 유리 너머로 우리를 보는 중

/** 평소에 가끔 짓는 표정 */
const IDLE_FACES: Expression[] = ["normal", "normal", "normal", "happy", "curious"];

/** 화면(유리)에 붙을 때 방 앞면보다 얼마나 더 나가는지. 더 나가면 발이 화면 아래로 잘린다 */
const GLASS_STEP = 0.55;
/** 유리에 붙어 있는 시간 (초). 동작 클립 길이와 비슷하게 */
const PEEK_HOLD = 5;

/** 가만히 있을 때 가끔 하는 동작 (doll_actions.py) */
const IDLE_MOTIONS: Motion[] = ["Sway", "Stretch", "Tilt", "Sway", "LookUp"];

/**
 * 리본이 행동: 평소엔 맵을 자유롭게 돌아다니고(가구 사이, 그림 구경), 부르면(ribbon.state 가 idle 이 아니게 되면)
 * 그 자리에서 멈춰 TV 쪽으로 돌아 손을 흔들고, "부르면 오는 자리"(layout.doll_spot)로 걸어온다.
 * 대화가 끝나고 returnAfterS 가 지나면 다시 돌아다닌다.
 * 듣는 중에는 맞장구(끄덕임), 그림 앞에서는 가리키기처럼 상황에 맞는 동작을 한 번씩 한다.
 */
export class RibbonBrain {
  private mode: Mode = { kind: "idle", until: 0 };
  private state: RibbonState = "idle";
  private lastGreet = -1e9;
  private nextReact = 0;
  private nextFace = 0;
  private thinkingSince = 0;
  private clock = 0;
  private gazeUntil = 0;
  private lastPeek = -1e9;
  private peekBack: P2 | null = null;
  nav: NavGrid | null = null;
  home: P2 = { x: 0, y: 0 };
  arts: ArtSpot[] = [];
  /** 앉을 수 있는 의자 (맵 배치에서 뽑는다) */
  chairs: LayoutItem[] = [];
  /** 1m 가 장면 단위로 몇인지 */
  unitPerM = 2.2222;
  /** 방 앞쪽(카메라 쪽) 가운데 바닥. 화면에 붙어 들여다볼 때 여기로 온다 */
  frontCenter: P2 = { x: 0, y: 0 };
  opts: BrainOptions = { wander: true, returnAfterS: 8 };
  /** 카메라(=TV 앞 아이들) 쪽. 매 프레임 index.ts 가 넣어 준다 */
  viewer = new THREE.Vector3();
  /** 카메라 폰이 본 얼굴 쪽 (없으면 null) */
  faceTarget: THREE.Vector3 | null = null;
  /** 같이 나온 다른 캐릭터 (겹치지 않게 자리를 피해 다닌다) */
  avoid: Ribbon3D | null = null;
  /** 부딪힐 것 같을 때 멈춰서 양보하는 쪽인가 (친구만 양보하고 리본이는 하던 일을 한다) */
  yields = false;
  private yieldUntil = 0;

  constructor(private body: Ribbon3D) {}

  /** 길찾기 격자가 바뀌었을 때. toHome 이면 "부르면 오는 자리"에, 아니면 막힌 곳에 있을 때만 가까운 빈 곳으로 */
  reset(toHome: boolean): void {
    if (!this.nav) return;
    this.body.standUp();
    const here = toHome ? this.home : this.body.pos;
    const p = this.nav.nearestFree(here) ?? here;
    if (toHome || !this.nav.isFree(here)) this.body.place(p, 0);
    this.body.stop();
    this.mode = this.called ? { kind: "called" } : { kind: "idle", until: this.clock + 1 };
    if (this.called) this.comeHome();
  }

  private get called(): boolean { return this.state !== "idle"; }

  /** 의자에 앉는 자리 (의자는 back=(0,1) 이라 앞이 -Y) */
  private seatOf(chair: LayoutItem) {
    const s = SEATS[chair.type];
    const a = rad(chair.rot);
    const fx = Math.sin(a), fy = -Math.cos(a);        // 의자가 바라보는 방향
    return {
      x: chair.x + fx * s.forward * this.unitPerM,
      y: chair.y + fy * s.forward * this.unitPerM,
      height: s.height * this.unitPerM,
      yaw: Math.atan2(fx, -fy),
    };
  }

  /** 의자 곁에 설 자리. 앞은 책상에 막혀 있을 때가 많아 옆·뒤도 본다 */
  private standSpots(chair: LayoutItem): P2[] {
    const a = rad(chair.rot);
    const fx = Math.sin(a), fy = -Math.cos(a);
    const d = 1.4;
    return [
      { x: chair.x + fx * d, y: chair.y + fy * d },      // 앞
      { x: chair.x - fy * d, y: chair.y + fx * d },      // 옆
      { x: chair.x + fy * d, y: chair.y - fx * d },      // 반대 옆
      { x: chair.x - fx * d, y: chair.y - fy * d },      // 뒤
    ];
  }

  setState(s: RibbonState): void {
    const was = this.state;
    this.state = s;
    this.body.setState(s);
    if (s === "thinking" && was !== "thinking") this.thinkingSince = this.clock;
    this.face();
    if (s !== "idle" && was === "idle") this.onCalled();
    if (s === "idle" && was !== "idle") this.mode = { kind: "linger", until: this.clock + this.opts.returnAfterS };
  }

  private onCalled(): void {
    if (this.peekBack) this.leaveGlass();     // 유리에 붙어 있었으면 먼저 방 안으로
    this.mode = { kind: "called" };
    this.body.standUp();
    this.body.stop();
    this.faceViewer();
    const greet = this.clock - this.lastGreet > 25;
    const go = () => { if (this.mode.kind === "called") this.comeHome(); };
    this.showFor("happy", 3);               // 부르면 반갑게
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
    // 부딪힐 것 같으면 걸음을 멈추고 지나갈 때까지 기다린다 (양보하는 쪽만)
    if (this.yields && this.avoid && this.body.moving && now > this.yieldUntil) {
      const o = this.avoid.pos, me = this.body.pos;
      if (Math.hypot(o.x - me.x, o.y - me.y) < (this.body.radius + this.avoid.radius) * 1.1) {
        this.yieldUntil = now + 2.5;
        this.body.stop();
        // 비켜서면서 상대를 쳐다본다
        this.body.lookAt(this.avoid.root.position.clone().setY(this.avoid.height * 0.8));
        this.mode = { kind: "idle", until: now + 1.5 };
        return;
      }
    }
    if (this.state === "thinking" && now - this.thinkingSince > 6) this.face();      // 오래 생각하면 걱정

    // 고개
    if (m.kind === "called" || m.kind === "linger" || m.kind === "peek") {
      this.body.lookAt(this.faceTarget ?? this.viewer);
    } else if (now > this.gazeUntil) {
      this.gazeUntil = now + 1.5 + Math.random() * 3;
      this.body.lookAt(this.idleGaze());
    }

    // 평소에는 가끔 표정을 바꾸고, 대화 중에는 상황 표정을 유지한다
    if (now > this.nextFace) {
      this.nextFace = now + 6 + Math.random() * 10;
      if (this.called) this.face();
      else if (m.kind === "sitting") this.body.setExpression(Math.random() < 0.4 ? "sleepy" : "normal");
      else if (m.kind === "peek") this.body.setExpression(Math.random() < 0.5 ? "curious" : "happy");
      else this.body.setExpression(IDLE_FACES[Math.floor(Math.random() * IDLE_FACES.length)]);
    }

    switch (m.kind) {
      case "called":
        if (!this.body.moving && !this.body.busy && Math.random() < dt * 0.5) this.faceViewer();
        this.react(now);
        break;
      case "linger":
        if (now > m.until) this.mode = { kind: "idle", until: now + 0.5 };
        break;
      case "sitting":
        if (now > m.until) { this.body.standUp(); this.mode = { kind: "idle", until: now + 1.2 }; }
        break;
      case "peek":
        if (now > m.until) this.leaveGlass();
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

  /** 지금 상황에 맞는 표정 */
  private face(look?: Expression): void {
    if (look) { this.body.setExpression(look); return; }
    switch (this.state) {
      case "listening": this.body.setExpression("normal"); return;
      case "thinking": this.body.setExpression(this.clock - this.thinkingSince > 6 ? "worried" : "thinking"); return;
      case "speaking": this.body.setExpression("talking"); return;
      default: this.body.setExpression(this.mode.kind === "sitting" ? "sleepy" : "normal");
    }
  }

  /** 아이가 나갈 때 등 잠깐 다른 표정을 지었다가 돌아온다 */
  showFor(look: Expression, seconds: number): void {
    this.face(look);
    this.nextFace = this.clock + seconds;
  }

  /** 대화 중 맞장구: 들을 때 끄덕임, 생각할 때 갸웃 */
  private react(now: number): void {
    if (now < this.nextReact || this.body.moving || this.body.busy) return;
    this.nextReact = now + 3 + Math.random() * 4;
    if (this.state === "listening" && Math.random() < 0.7) this.body.play(Math.random() < 0.85 ? "Nod" : "Tilt");
    else if (this.state === "thinking" && Math.random() < 0.5) this.body.play("LookUp");
  }

  /** 아이가 들어왔을 때: 놀랐다가 반가워하기 */
  celebrate(): void {
    if (this.body.moving || this.body.busy) return;
    this.faceViewer();
    this.lastGreet = this.clock;
    this.showFor("surprised", 1.2);
    setTimeout(() => { this.face("happy"); this.nextFace = this.clock + 4; this.body.play(Math.random() < 0.5 ? "Clap" : "Jump"); }, 900);
    this.mode = { kind: "idle", until: this.clock + 5 };
  }

  /** 아이가 나갈 때: 잠깐 아쉬운 표정 */
  farewell(): void {
    this.showFor("sad", 3);
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
    if (r < 0.25 && this.body.play(IDLE_MOTIONS[Math.floor(Math.random() * IDLE_MOTIONS.length)])) {
      this.mode = { kind: "idle", until: this.clock + 4 + Math.random() * 4 };
      return;
    }
    if (r < 0.35 && this.clock - this.lastGreet > 30) {
      // 가끔 TV 쪽으로 손 흔들기
      this.faceViewer();
      this.lastGreet = this.clock;
      setTimeout(() => this.body.greet(), 400);
      this.mode = { kind: "idle", until: this.clock + 5 };
      return;
    }
    if (r < 0.32 && this.clock - this.lastPeek > 90 && this.peekAtGlass()) return;
    if (r < 0.4 && this.arts.length && this.visitArt()) return;
    if (r < 0.6 && this.body.canSit && this.sitOnChair()) return;
    const me = this.body.pos;
    const other = this.avoid?.pos ?? null;
    const dest = nav.randomFree((p) => Math.hypot(p.x - me.x, p.y - me.y) > 2.5
      && (!other || Math.hypot(p.x - other.x, p.y - other.y) > 2.5));
    const path = dest && nav.findPath(me, dest);
    if (!path) { this.mode = { kind: "idle", until: this.clock + 2 }; return; }
    this.body.walkPath(path, () => {
      if (Math.random() < 0.35) this.faceViewer();
    });
    this.mode = { kind: "walk" };
  }

  /** 의자에 가서 앉기 */
  private sitOnChair(): boolean {
    const nav = this.nav;
    if (!nav || !this.chairs.length) return false;
    for (const chair of [...this.chairs].sort(() => Math.random() - 0.5).slice(0, 4)) {
      const seat = this.seatOf(chair);
      const stand = this.standSpots(chair).find((p) => nav.isFree(p));
      if (!stand) continue;
      const path = nav.findPath(this.body.pos, stand);
      if (!path) continue;
      this.body.walkPath(path, () => {
        this.body.facePoint(seat);          // 의자 쪽을 한 번 보고
        setTimeout(() => {
          if (this.mode.kind !== "walk" && this.mode.kind !== "idle") return;
          this.body.sitOn(seat);
          this.mode = { kind: "sitting", until: this.clock + 12 + Math.random() * 18 };
        }, 700);
      });
      this.mode = { kind: "walk" };
      return true;
    }
    return false;
  }

  /**
   * 화면 코앞으로 와서 유리 너머로 우리를 보기.
   * 길찾기 격자는 벽 여백만큼 앞쪽을 비워 두므로, 격자 안에서 갈 수 있는 제일 앞자리까지 걸어간 뒤
   * 마지막 한 걸음은 격자 밖(화면 바로 앞)으로 더 나간다. 다 보고 나면 그 자리로 되돌아온다.
   */
  peekAtGlass(): boolean {
    const nav = this.nav;
    if (!nav || !this.body.can("Peek")) return false;
    const me = this.body.pos;
    // 앞쪽 가운데부터 조금씩 뒤로 물러나며 설 수 있는 자리를 찾는다
    let stand: P2 | null = null;
    for (let back = 0; back < 3 && !stand; back += 0.3) {
      for (const dx of [0, 0.8, -0.8, 1.6, -1.6]) {
        const p = { x: this.frontCenter.x + dx, y: this.frontCenter.y + back };
        if (nav.isFree(p)) { stand = p; break; }
      }
    }
    const path = stand && nav.findPath(me, stand);
    if (!path || !stand) return false;
    this.lastPeek = this.clock;
    this.peekBack = stand;
    const glass = { x: this.frontCenter.x, y: this.frontCenter.y - GLASS_STEP };
    this.body.walkPath([...path, glass], () => {
      this.faceViewer();
      // 돌아서는 시간을 조금 주고 유리에 손을 짚는다
      setTimeout(() => {
        if (this.called) { this.leaveGlass(); return; }
        this.showFor("curious", PEEK_HOLD);
        this.body.play("Peek");
        this.mode = { kind: "peek", until: this.clock + PEEK_HOLD };
      }, 350);
    });
    this.mode = { kind: "walk" };
    return true;
  }

  /** 유리 앞에서 물러나 길찾기 격자 안으로 돌아온다 (밖에 서 있으면 다음 길을 못 찾는다) */
  private leaveGlass(): void {
    const back = this.peekBack;
    this.peekBack = null;
    this.mode = { kind: "idle", until: this.clock + 1 };
    if (!back) return;
    this.body.stop();
    this.body.walkPath([back]);
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
        this.gazeUntil = this.clock + 6;
        this.showFor("curious", 6);          // 그림을 보며 궁금한 표정
        setTimeout(() => this.body.play(Math.random() < 0.6 ? "Point" : "Tilt"), 700);
      });
      this.mode = { kind: "walk" };
      return true;
    }
    return false;
  }
}
