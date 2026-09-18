import * as THREE from "three";
import type { RibbonState } from "../protocol";
import type { Blocker, NavGrid, P2 } from "../world/nav";
import type { ArtSpot } from "../world/room";
import { rad, SEATS, toFloor, type LayoutItem } from "../world/types";
import type { Expression } from "./face";
import type { GlassLayer } from "./glass";
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
  | { kind: "peek" };                        // 화면(유리)에 바짝 붙어 너머를 보려고 애쓰는 중 (glass.ts)

/** 평소에 가끔 짓는 표정 */
const IDLE_FACES: Expression[] = ["normal", "normal", "normal", "happy", "curious"];

/** 화면에 붙으러 갈 때 방 앞면에서 더 걸어 나가는 거리. 여기까지 오면 화면 아래로 빠져나가 안 보인다 */
const OUT_STEP = 2.6;

/** 가만히 있을 때 가끔 하는 동작 (doll_actions.py) */
const IDLE_MOTIONS: Motion[] = ["Sway", "Stretch", "Tilt", "Sway", "LookUp"];

/**
 * 리본이 행동: 평소엔 맵을 자유롭게 돌아다니고(가구 사이, 그림 구경), 부르면(ribbon.state 가 idle 이 아니게 되면)
 * 그 자리에서 멈춰 TV 쪽으로 돌아 손을 흔들고, "부르면 오는 자리"(layout.doll_spot)로 걸어온다.
 * 대화가 끝나고 returnAfterS 가 지나면 다시 돌아다닌다.
 * 듣는 중에는 맞장구(끄덕임), 그림 앞에서는 가리키기처럼 상황에 맞는 동작을 한 번씩 한다.
 *
 * 겹치지 않기
 * - 가구: 길찾기 격자가 몸 반지름(머리·머리카락까지)만큼 막는다. 의자는 옆(또는 앞)에 섰다가 좌판으로 천천히 올라앉고,
 *   일어날 때 그 자리로 천천히 내려온다 (서서 걸어 들어가면 다리가 의자·책상을 뚫는다. 뛰지는 않는다: 아이들이 따라 한다).
 *   앞은 책상, 양옆은 다른 의자로 막힌 의자(줄 가운데)는 뒤에서 조용히 들어간다 (잠깐 등받이와 겹쳐 보인다)
 * - 다른 캐릭터: 길을 찾을 때 그 자리(와 가는 곳)를 피해 가고, 걷다가 부딪힐 것 같으면 멈춘다.
 *   리본이는 잠깐 기다렸다가 돌아가는 길을 다시 찾고, 친구(yields)는 비켜선다. 리본이가 가려는 곳에 친구가 있어도 비켜선다.
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
  /** 화면에 붙는 모습을 그리는 층 (stage.glass) */
  glass: GlassLayer | null = null;
  /** 같이 나온 다른 캐릭터의 브레인 (화면에 붙으러 갈 때 부른다) */
  buddy: RibbonBrain | null = null;
  private glassDone: (() => void) | null = null;
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
  /** 의자에 올라앉기 전에 섰던 자리 (일어나면 여기로 내려온다) */
  private sitExit: P2 | null = null;
  private blockedSince: number | null = null;
  private nextReplan = 0;

  constructor(private body: Ribbon3D) {}

  /** 길찾기 격자가 바뀌었을 때. toHome 이면 "부르면 오는 자리"에, 아니면 막힌 곳에 있을 때만 가까운 빈 곳으로 */
  reset(toHome: boolean): void {
    if (!this.nav) return;
    if (this.glass?.isOn(this.body)) { this.glassDone = () => undefined; this.glass.leave(this.body); }
    this.peekBack = null;
    this.body.root.visible = true;
    this.body.standUp();
    this.sitExit = null;
    this.blockedSince = null;
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

  /**
   * 의자에 올라앉을 때 설 자리: 옆이나 앞이 좋고, 둘 다 막혔으면 뒤 (잠깐 등받이와 겹친다).
   * 거기서 좌판까지 가는 길에 이 의자와 앉으면 원래 닿는 가구(책상) 말고 다른 가구가 없어야 한다.
   * 책상 앞에 줄지어 놓인 의자는 앞이 책상, 양옆이 다른 의자라 보통 뒤에서 들어간다
   */
  private approachSpot(chair: LayoutItem, seat: P2): P2 | null {
    const nav = this.nav!;
    const a = rad(chair.rot);
    const fx = Math.sin(a), fy = -Math.cos(a);          // 의자가 바라보는 쪽
    const r = this.body.radius * 0.8;
    const allowed = [chair, ...nav.itemsAt(seat, r)];    // 앉으면 원래 닿는 것 (의자, 밀어 넣은 책상)
    const dirs = [{ x: fx, y: fy }, { x: -fy, y: fx }, { x: fy, y: -fx }];   // 앞, 옆, 반대 옆
    for (const d of [1.1, 1.4, 1.8]) {
      for (const dir of dirs) {
        const p = { x: seat.x + dir.x * d, y: seat.y + dir.y * d };
        if (nav.isFree(p) && nav.lineFits(p, seat, r, allowed)) return p;
      }
    }
    // 뒤: 등받이 쪽에서 조용히 들어간다
    for (const d of [1.3, 1.6, 2.0]) {
      const p = { x: seat.x - fx * d, y: seat.y - fy * d };
      if (nav.isFree(p) && nav.lineFits(p, seat, r, allowed)) return p;
    }
    return null;
  }

  // ---- 다른 캐릭터와 겹치지 않기 ----

  /** 두 캐릭터 가운데 사이가 이보다 가까우면 겹친다 */
  private clearance(): number { return this.body.radius + (this.avoid?.radius ?? 0) + 0.15; }

  /** 이 자리에 다른 캐릭터가 있거나 가는 중인가 */
  private occupied(p: P2, extra = 0): boolean {
    const o = this.avoid;
    if (!o) return false;
    const c = this.clearance() + extra;
    const d = o.destination;
    return dist(o.pos, p) < c || (!!d && dist(d, p) < c);
  }

  /** 길을 찾을 때 피할 곳: 다른 캐릭터 자리와 그가 가는 곳. 내 목적지를 막고 있으면 그건 빼고 (비켜 주길 기다린다) */
  private blockers(goal: P2): Blocker[] {
    const o = this.avoid;
    if (!o) return [];
    const r = this.clearance();
    return [o.pos, o.destination].filter((p): p is P2 => !!p && dist(p, goal) >= r).map((p) => ({ p, r }));
  }

  private pathTo(goal: P2): P2[] | null {
    return this.nav?.findPath(this.body.pos, goal, this.blockers(goal)) ?? null;
  }

  /** 걷다가 앞에 다른 캐릭터가 있으면 멈춘다. 리본이는 돌아가는 길을 다시 찾고, 친구는 비켜선다 */
  private steer(now: number): void {
    const o = this.avoid!;
    const me = this.body.pos, next = this.body.nextPoint;
    if (!next || this.body.sitting) return;
    const c = this.clearance();
    const d0 = dist(me, o.pos);
    const len = dist(me, next);
    const k = len > 1e-4 ? Math.min(0.35, len) / len : 0;
    const d1 = dist({ x: me.x + (next.x - me.x) * k, y: me.y + (next.y - me.y) * k }, o.pos);
    const blocked = d1 < c && d1 < d0;      // 다음 걸음이 더 가까워지면서 겹친다
    if (!blocked) {
      if (this.blockedSince !== null) { this.body.hold(false); this.blockedSince = null; }
      return;
    }
    if (this.blockedSince === null) {
      this.blockedSince = now;
      this.body.hold(true);
      this.body.lookAt(o.root.position.clone().setY(o.height * 0.8));   // 멈춰서 상대를 본다
    }
    const waited = now - this.blockedSince;
    if (this.yields) {
      if (waited > 0.8) { this.body.stop(); this.blockedSince = null; this.stepAside(); }
      return;
    }
    const dest = this.body.destination!;
    if (waited > 0.6 && now > this.nextReplan) {
      this.nextReplan = now + 0.8;
      const path = this.pathTo(dest);
      if (path?.length) { this.body.replacePath(path); this.blockedSince = null; return; }
    }
    if (waited > 6) {                       // 끝내 못 가면 그 자리에서 멈춘다
      this.body.stop();
      this.blockedSince = null;
      if (this.called) this.faceViewer(); else this.mode = { kind: "idle", until: now + 1 };
    }
  }

  /** 친구: 리본이가 오는 곳·가는 곳에서 비켜선다 */
  private stepAside(): void {
    const nav = this.nav, o = this.avoid;
    if (!nav || !o) return;
    if (this.body.sitting) { this.leaveSeat(() => this.stepAside()); return; }
    const me = this.body.pos, c = this.clearance();
    // 리본이가 지나갈 길(지금 자리 → 가는 곳) 위로 비켜서면 또 막는다 → 그 선에서 넉넉히 떨어진 곳으로
    const from = o.pos, to = o.destination ?? o.pos;
    const dest = nav.randomFree((p) => dist(p, me) > 1 && dist(p, me) < 6 && segDist(p, from, to) > c * 1.5, 400)
      ?? nav.randomFree((p) => dist(p, me) > 1 && !this.occupied(p, c * 0.5));
    const path = dest && this.pathTo(dest);
    this.yieldUntil = this.clock + 2;
    if (!path) { this.mode = { kind: "idle", until: this.clock + 1 }; return; }
    this.body.walkPath(path, () => this.body.lookAt(o.root.position.clone().setY(o.height * 0.8)));
    this.mode = { kind: "walk" };
  }

  /** 의자에서 올라왔던 자리로 천천히 내려온다 (그대로 걸어 나가면 의자·책상을 뚫는다) */
  private leaveSeat(then?: () => void): void {
    const exit = this.sitExit;
    this.sitExit = null;
    if (exit) this.body.climbOff(exit, then);
    else { this.body.standUp(); then?.(); }
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
    if (this.peekBack) {                      // 화면에 붙어 있었으면 먼저 내려가 방 안으로 들어온 뒤
      this.mode = { kind: "called" };
      this.leaveGlass(() => { if (this.mode.kind === "called") this.answerCall(); });
      return;
    }
    this.mode = { kind: "called" };
    this.body.hold(false);
    this.blockedSince = null;
    if (this.body.sitting) {                  // 앉아 있었으면 앞으로 걸어 나온 뒤
      this.body.stop();
      this.leaveSeat(() => { if (this.mode.kind === "called") this.answerCall(); });
      return;
    }
    this.body.stop();
    this.answerCall();
  }

  /** 불렸을 때: TV 쪽을 보고 (가끔) 손을 흔든 뒤 "부르면 오는 자리"로 */
  private answerCall(): void {
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
    const path = this.pathTo(home);
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
    // 다른 캐릭터와 겹치지 않기
    if (this.avoid) {
      if (this.body.moving) this.steer(now);
      else if (this.yields && now > this.yieldUntil && m.kind !== "called" && m.kind !== "peek") {
        // 친구: 리본이가 내 자리로 오거나 이미 겹쳐 있으면 비켜선다
        const d = this.avoid.destination;
        const c = this.clearance();
        if ((d && dist(d, this.body.pos) < c) || dist(this.avoid.pos, this.body.pos) < c) this.stepAside();
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
        if (now > m.until) { this.leaveSeat(); this.mode = { kind: "walk" }; }
        break;
      case "walk":
        if (!this.body.moving && !this.body.climbing) this.mode = { kind: "idle", until: now + 2 + Math.random() * 5 };
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
    if (r < 0.32 && this.clock - this.lastPeek > 90 && this.peekAtGlass()) return;   // 화면에 바짝 붙어 들여다보기
    if (r < 0.4 && this.arts.length && this.visitArt()) return;
    if (r < 0.6 && this.body.canSit && this.sitOnChair()) return;
    const me = this.body.pos;
    const dest = nav.randomFree((p) => dist(p, me) > 2.5 && !this.occupied(p, 1.2));
    const path = dest && this.pathTo(dest);
    if (!path) { this.mode = { kind: "idle", until: this.clock + 2 }; return; }
    this.body.walkPath(path, () => {
      if (Math.random() < 0.35) this.faceViewer();
    });
    this.mode = { kind: "walk" };
  }

  /** 의자에 가서 앉기: 의자 옆(앞·뒤)까지 걸어가서 좌판으로 천천히 올라앉는다 */
  private sitOnChair(): boolean {
    const nav = this.nav;
    if (!nav || !this.chairs.length) return false;
    for (const chair of [...this.chairs].sort(() => Math.random() - 0.5)) {
      const seat = this.seatOf(chair);
      if (this.occupied(seat)) continue;                  // 다른 캐릭터가 앉았거나 가는 중
      const spot = this.approachSpot(chair, seat);
      if (!spot || this.occupied(spot)) continue;
      const path = this.pathTo(spot);
      if (!path) continue;
      this.body.walkPath(path, () => {
        if (this.mode.kind !== "walk") return;
        this.body.climbOnto(seat, () => {
          if (this.mode.kind !== "walk") return;
          this.mode = { kind: "sitting", until: this.clock + 12 + Math.random() * 18 };
        });
        this.sitExit = spot;                               // 올라가는 중에 불려도 이리로 내려온다
      });
      this.mode = { kind: "walk" };
      return true;
    }
    return false;
  }

  /**
   * 화면(유리)에 바짝 붙어 너머를 보려고 애쓰기.
   * 방 앞쪽까지 걸어와 화면 아래로 걸어 나가면(방 카메라가 멀리 있어서 가까이 오기 전에 화면 밖으로 나간다),
   * 유리창 층(glass.ts)에서 같은 캐릭터가 화면 아래로부터 크게 올라와 유리에 손을 짚고 두리번거린다.
   * 다 보면 내려가고, 방 캐릭터가 다시 걸어 들어온다. 같이 나온 친구도 가끔 옆에 같이 붙는다 (invited).
   */
  peekAtGlass(preferX = this.frontCenter.x, invited = false): boolean {
    const nav = this.nav;
    if (!nav || !this.glass || this.peekBack) return false;
    // 앞쪽에서 조금씩 뒤로 물러나며 설 수 있는 자리를 찾는다
    let stand: P2 | null = null;
    for (let back = 0; back < 3 && !stand; back += 0.3) {
      for (const dx of [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8]) {
        const p = { x: preferX + dx, y: this.frontCenter.y + back };
        if (nav.isFree(p) && !this.occupied(p)) { stand = p; break; }
      }
    }
    if (!stand) return false;
    const out = { x: stand.x, y: this.frontCenter.y - OUT_STEP };
    if (this.occupied(out)) return false;
    const path = this.pathTo(stand);
    if (!path) return false;
    this.lastPeek = this.clock;
    this.peekBack = stand;
    this.body.walkPath([...path, out], () => {
      if (this.called || !this.glass) { this.leaveGlass(); return; }
      this.mode = { kind: "peek" };
      this.glass.enter(this.body, stand!.x, () => {
        const done = this.glassDone ?? (() => this.backFromGlass());
        this.glassDone = null;
        done();
      });
    });
    this.mode = { kind: "walk" };
    if (!invited) this.buddy?.joinPeek(stand.x);
    return true;
  }

  /** 다른 캐릭터가 화면에 붙으러 갈 때: 가끔 옆에 같이 붙는다 */
  joinPeek(x: number): void {
    const m = this.mode.kind;
    if (this.called || this.peekBack || m === "peek" || this.clock - this.lastPeek < 20 || Math.random() > 0.7) return;
    const side = x + (this.body.pos.x < x ? -1 : 1) * 2.4;       // 내가 있는 쪽 옆자리
    const go = () => { if (!this.called && !this.peekBack) this.peekAtGlass(side, true); };
    if (this.body.sitting) { this.leaveSeat(go); return; }
    this.body.stop();
    go();
  }

  /** 다 보고 내려왔을 때: 방 안 제자리로 걸어 들어온다 */
  private backFromGlass(): void {
    const back = this.peekBack;
    this.peekBack = null;
    this.mode = { kind: "walk" };
    if (back) this.body.walkPath([back]);
  }

  /** 화면에서 먼저 물러나기 (불렸을 때 등). 붙어 있으면 내려간 뒤, 가는 중이면 멈추고 방 안으로 돌아온 뒤 then */
  private leaveGlass(then?: () => void): void {
    const back = this.peekBack;
    const finish = () => {
      this.peekBack = null;
      if (back) this.body.walkPath([back], then);
      else then?.();
    };
    if (this.glass?.isOn(this.body)) {
      this.glassDone = finish;
      this.glass.leave(this.body);
      return;
    }
    this.body.stop();
    finish();
  }

  /** 걸린 그림 앞에 가서 구경하기 */
  private visitArt(): boolean {
    const nav = this.nav!;
    const art = this.arts[Math.floor(Math.random() * this.arts.length)];
    const n = new THREE.Vector3(art.normal.x, 0, art.normal.z).normalize();
    for (const d of [1.8, 2.4, 3.0]) {
      const stand = toFloor(art.center.clone().setY(0).addScaledVector(n, d));
      if (!nav.isFree(stand) || this.occupied(stand)) continue;
      const path = this.pathTo(stand);
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

const dist = (a: P2, b: P2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** 점 p 에서 선분 a-b 까지 거리 */
function segDist(p: P2, a: P2, b: P2): number {
  const vx = b.x - a.x, vy = b.y - a.y;
  const L = vx * vx + vy * vy;
  const t = L > 1e-9 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L)) : 0;
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}
