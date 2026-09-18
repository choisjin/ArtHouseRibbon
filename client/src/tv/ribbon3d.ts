import * as THREE from "three";
import type { RibbonState } from "../protocol";
import { applyLook, characterOf, loadDoll, type CharacterSpec, type RibbonLook } from "../world/doll";
import { Face, type Expression } from "./face";
import type { P2 } from "../world/nav";
import { toThree } from "../world/types";

/** 제자리 걷기 액션이 timeScale 1 일 때 한 걸음이 나아가는 속도 (doll.py WALK_SPEED × 24fps) */
const ANIM_WALK_SPEED = 0.547;
const TURN_RATE = 5;              // rad/s
/** 뼈 노드 이름. GLTFLoader 가 이름의 점을 지우므로 블렌더의 arm.R 은 armR */
const BONES = ["pelvis", "spine", "head", "armL", "armR", "legL", "legR"] as const;
/** 인사는 오른팔만 (원래 액션의 고개 갸웃·몸 흔들기·통통 튀기는 빼고) */
const GREET_TRACKS = /^armR\./;
/** 한 번씩 재생하는 동작 (doll_actions.py). Greet 은 오른팔만 남겨 Wave 로 넣는다 */
export type Motion = "Wave" | "Nod" | "Shake" | "Tilt" | "Sway" | "Stretch" | "Point" | "Clap" | "Jump"
  | "LookUp" | "Peek";        // Peek: 화면(유리) 코앞에 붙어 두 손을 짚고 들여다보기

/** 앉을 자리: 바닥 좌표와 좌판 높이(장면 단위), 앉아서 바라보는 방향 */
export interface Seat { x: number; y: number; height: number; yaw: number }

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const approach = (cur: number, target: number, k: number) => cur + (target - cur) * k;

/**
 * 캐릭터 몸: <캐릭터>.glb + Walk/Greet 액션 + 코드로 만드는 움직임(숨쉬기·고개 돌리기·말할 때 끄덕임).
 * 어디로 갈지는 brain.ts 가 정하고, 여기서는 받은 경로를 따라 걷고 돌아선다.
 * 좌표는 배치 파일 바닥 단위(P2). 정면은 three.js +Z (TV 카메라 쪽).
 */
export class Ribbon3D {
  readonly root = new THREE.Group();
  height = 2.4;
  /** 몸이 차지하는 바닥 반지름: 머리·머리카락·팔까지 위에서 본 가장 먼 점 (가구·다른 캐릭터와 이만큼 떨어진다) */
  radius = 0.45;
  speed = 0.9;                       // 초당 단위
  private body = new THREE.Group();  // 숨쉬기·끄덕임을 얹는 층
  private mixer: THREE.AnimationMixer | null = null;
  private walk: THREE.AnimationAction | null = null;
  private motions = new Map<string, THREE.AnimationAction>();
  private playing: string | null = null;
  private bones = new Map<string, { node: THREE.Object3D; proxy: THREE.Object3D }>();
  /** 액션은 뼈 사본(proxy)에서 돌리고 결과만 실제 뼈에 옮긴다.
   *  three.js 는 값이 지난 프레임과 같으면 다시 쓰지 않는데, 우리가 뼈를 직접 건드리면
   *  자세를 유지하는 동작(가리키기 등)이 풀려 버리기 때문이다. */
  private rig = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private look: Partial<RibbonLook> | undefined;
  /** 어떤 캐릭터인가 (리본이 / 올리). 옷 부품 앞머리와 색 바꿀 재질이 캐릭터마다 다르다 */
  readonly spec: CharacterSpec;
  private path: P2[] = [];
  private onArrive: (() => void) | null = null;
  private yaw = 0;
  private targetYaw: number | null = null;
  private walkWeight = 0;
  private motionDone: (() => void) | null = null;
  private gaze: THREE.Vector3 | null = null;
  private headYaw = 0;
  private headPitch = 0;
  private tilt = 0;
  private nod = 0;
  private mouth = 0;
  private sitAction: THREE.AnimationAction | null = null;
  private seat: Seat | null = null;
  private held = false;           // 길은 그대로 두고 잠깐 멈춤 (앞에 다른 캐릭터가 있을 때)
  /** 의자에 천천히 올라앉기 / 내려오기 (뛰지 않는다: 아이들이 따라 할 수 있다) */
  private climb: { from: P2; to: P2; t: number; dur: number; l0: number; l1: number; y0: number; y1: number; up: boolean;
                   done: (() => void) | null } | null = null;
  private lift = 0;               // 바닥에서 띄운 높이 (앉으면 좌판 높이 - 엉덩이 높이)
  private hipHeight = 0.46;       // 서 있을 때 골반(엉덩이)이 발바닥에서 얼마나 위인지
  private liftTarget = 0;
  private shadow: THREE.Mesh;
  private shadowR = 0.45;
  private face: Face | null = null;
  private expression: Expression = "normal";
  private motionBlend = 1;
  private t = 0;
  state: RibbonState = "idle";
  loaded: Promise<void>;

  constructor(character?: string) {
    this.spec = characterOf(character);
    this.root.add(this.body);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 32), new THREE.MeshBasicMaterial({
      map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.2,
    }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.008;
    shadow.name = "shadow";
    this.shadow = shadow;
    this.root.add(shadow);
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    const { scene, animations } = await loadDoll(this.spec.file);
    this.model = scene;
    applyLook(scene, this.look, this.spec);
    this.body.add(scene);
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    // 뼈 사본 만들기 (같은 이름·같은 부모 구조)
    const proxies = new Map<string, THREE.Object3D>();
    const nodes: THREE.Object3D[] = [];
    scene.traverse((o) => { if ((BONES as readonly string[]).includes(o.name)) nodes.push(o); });
    for (const node of nodes) {
      const proxy = new THREE.Object3D();
      proxy.name = node.name;
      proxy.position.copy(node.position);
      proxy.quaternion.copy(node.quaternion);
      proxies.set(node.name, proxy);
      this.bones.set(node.name, { node, proxy });
    }
    for (const node of nodes) {
      let p: THREE.Object3D | null = node.parent;
      while (p && !proxies.has(p.name)) p = p.parent;
      (p ? proxies.get(p.name)! : this.rig).add(proxies.get(node.name)!);
    }
    this.hipHeight = this.bones.get("pelvis")?.node.position.y ?? 0.46;
    this.face = new Face(scene);
    this.face.set(this.expression);
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    this.height = size.y;
    // 큰 머리가 몸보다 넓다. 상자 폭의 일부만 쓰면 가구 옆을 지날 때 머리가 책상 위로 튀어나온다 →
    // 꼭짓점들 중 몸 가운데 축에서 가장 먼 거리를 반지름으로 (어느 쪽으로 돌아서도 같다)
    this.radius = horizontalRadius(scene) || Math.max(size.x, size.z) * 0.5;
    this.shadowR = Math.max(size.x, size.z) * 0.4;   // 그림자는 발밑 크기로
    const shadow = this.root.getObjectByName("shadow")!;
    shadow.scale.setScalar(this.shadowR * 1.1);

    this.mixer = new THREE.AnimationMixer(this.rig);
    const clip = (n: string) => animations.find((a) => a.name === n);
    const walk = clip("Walk"), greet = clip("Greet");
    if (walk) {
      this.walk = this.mixer.clipAction(walk);
      this.walk.setEffectiveWeight(0).play();
    }
    if (greet) {
      this.addMotion(new THREE.AnimationClip("Wave", greet.duration, greet.tracks.filter((t) => GREET_TRACKS.test(t.name))));
    }
    for (const c of animations) {
      if (c.name !== "Walk" && c.name !== "Greet" && c.name !== "Sit") this.addMotion(c);
    }
    const sitClip = clip("Sit");
    if (sitClip) {
      this.sitAction = this.mixer.clipAction(sitClip);    // 앉아 있는 동안 계속 도는 동작
      this.sitAction.setLoop(THREE.LoopRepeat, Infinity);
    }
    this.mixer.addEventListener("finished", (e) => {
      const name = [...this.motions].find(([, a]) => a === e.action)?.[0];
      if (!name || name !== this.playing) return;
      e.action.fadeOut(0.25);
      this.playing = null;
      const cb = this.motionDone; this.motionDone = null; cb?.();
    });
  }

  private addMotion(clip: THREE.AnimationClip): void {
    const a = this.mixer!.clipAction(clip);
    a.setLoop(THREE.LoopOnce, 1);
    this.motions.set(clip.name, a);
  }

  /** 이 동작을 할 수 있는가 (인형 파일에 들어 있는가) */
  can(name: Motion): boolean { return this.motions.has(name); }

  /** 동작 한 번. 걷는 중이면 하지 않는다. speed 1 보다 작으면 느리게(오래) */
  play(name: Motion, onDone?: () => void, speed = 1): boolean {
    const a = this.motions.get(name);
    if (!a || this.moving || this.playing) { onDone?.(); return false; }
    this.playing = name;
    this.motionDone = onDone ?? null;
    a.reset().setEffectiveWeight(1).fadeIn(0.2).play();
    a.timeScale = speed;
    return true;
  }

  get currentLook(): Partial<RibbonLook> | undefined { return this.look; }

  /** 하던 동작을 바로 멈춘다 (유리창 층 사본을 치울 때) */
  cancelMotion(): void {
    if (!this.playing) return;
    this.motions.get(this.playing)?.stop();
    this.playing = null;
    this.motionDone = null;
  }

  setLook(look: Partial<RibbonLook> | undefined): void {
    this.look = look;
    if (this.model) applyLook(this.model, look, this.spec);
  }

  get pos(): P2 { return { x: this.root.position.x, y: -this.root.position.z }; }
  get moving(): boolean { return this.path.length > 0; }
  /** 가는 중인 곳 (마지막 점). 서 있으면 null */
  get destination(): P2 | null { return this.path.length ? this.path[this.path.length - 1] : null; }
  /** 다음에 밟을 점 */
  get nextPoint(): P2 | null { return this.path[0] ?? null; }
  get busy(): boolean { return this.playing !== null; }
  /** 지금 하는 동작 이름 */
  get motion(): string | null { return this.playing; }
  get facing(): number { return this.yaw; }
  /** 머리 위 한 점 (말풍선 위치) */
  headTop(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.root.position).setY(this.root.position.y + this.height * 1.02);
  }

  place(p: P2, yaw = 0): void {
    this.root.position.copy(toThree(p.x, p.y));
    this.yaw = yaw;
    this.root.rotation.y = yaw;
    this.path = [];
    this.climb = null;
    this.held = false;
  }

  walkPath(path: P2[], onArrive?: () => void): void {
    this.path = [...path];
    this.onArrive = onArrive ?? null;
    this.targetYaw = null;
  }

  stop(): void {
    this.path = [];
    this.onArrive = null;
    this.held = false;
  }

  /** 도착하면 할 일은 두고 길만 바꾼다 (앞이 막혀 돌아갈 때) */
  replacePath(path: P2[]): void {
    this.path = [...path];
    this.held = false;
  }

  /** 길은 그대로 두고 잠깐 멈춘다 / 다시 걷는다 */
  hold(on: boolean): void { this.held = on; }
  get holding(): boolean { return this.held; }

  /** 제자리에서 이 방향(three.js y 회전)으로 돌아선다 */
  faceYaw(yaw: number | null): void { this.targetYaw = yaw; }
  /** 바닥 점을 보도록 돌아선다 */
  facePoint(p: P2): void {
    const me = this.pos;
    this.targetYaw = Math.atan2(p.x - me.x, -(p.y - me.y));
  }
  /** 고개만 이 점(three.js 월드)을 본다. null 이면 정면 */
  lookAt(p: THREE.Vector3 | null): void { this.gaze = p ? p.clone() : null; }

  greet(onDone?: () => void): void { this.play("Wave", onDone); }

  /** 앉을 수 있는가 (인형 파일에 앉은 자세가 있는가) */
  get canSit(): boolean { return this.sitAction !== null; }
  get sitting(): boolean { return this.seat !== null; }

  /** 좌판에 앉았을 때 몸을 띄우는 높이: 발이 아니라 엉덩이가 좌판에 닿게 (+ 살짝 얹히게) */
  private seatLift(seat: Seat): number { return Math.max(0, seat.height - this.hipHeight + 0.04); }

  /**
   * 의자 옆(또는 앞·뒤)에 서 있다가 좌판으로 천천히 올라앉는다. 서서 좌판까지 걸어가면 다리가 의자를 뚫으므로
   * 좌판 쪽으로 옮겨 가면서 몸을 좌판 높이까지 먼저 올리고, 앉은 자세로 바꾸며 돌아앉는다. 위로 솟구치지 않는다.
   */
  climbOnto(seat: Seat, onDone?: () => void): void {
    if (!this.sitAction) { onDone?.(); return; }
    this.stop();
    this.seat = seat;
    this.sitAction.reset().setEffectiveWeight(1).fadeIn(0.8).play();
    const l1 = this.seatLift(seat);
    this.liftTarget = l1;
    this.climb = { from: this.pos, to: { x: seat.x, y: seat.y }, t: 0, dur: 1.1, l0: this.lift, l1, y0: this.yaw, y1: seat.yaw,
                   up: true, done: onDone ?? null };
  }

  /** 좌판에서 이 자리(올라왔던 곳)로 천천히 내려온다: 좌판에서 먼저 빠져나온 뒤 몸을 내린다 */
  climbOff(to: P2, onDone?: () => void): void {
    this.stop();
    this.seat = null;
    this.sitAction?.fadeOut(0.8);
    this.liftTarget = 0;
    const me = this.pos;
    const y1 = Math.atan2(to.x - me.x, -(to.y - me.y));
    this.climb = { from: me, to, t: 0, dur: 1.0, l0: this.lift, l1: 0, y0: this.yaw, y1, up: false, done: onDone ?? null };
  }

  /** 오르내리는 중이면 한 프레임 진행 (자리·높이·방향). 아니면 false */
  private stepClimb(dt: number): boolean {
    const c = this.climb;
    if (!c) return false;
    c.t += dt;
    const k = Math.min(1, c.t / c.dur);
    const ease = (x: number) => { const v = Math.min(1, Math.max(0, x)); return v * v * (3 - 2 * v); };
    const e = ease(k);
    this.root.position.x = c.from.x + (c.to.x - c.from.x) * e;
    this.root.position.z = -(c.from.y + (c.to.y - c.from.y) * e);
    // 올라갈 때는 높이를 먼저(앞 70% 동안), 내려올 때는 좌판에서 빠져나온 뒤에(뒤 70% 동안) 바꾼다
    this.lift = c.l0 + (c.l1 - c.l0) * (c.up ? ease(k / 0.7) : ease((k - 0.3) / 0.7));
    this.yaw = c.y0 + wrap(c.y1 - c.y0) * e;
    if (k >= 1) {
      this.climb = null;
      this.lift = c.l1;
      this.targetYaw = null;
      c.done?.();
    }
    return true;
  }
  get climbing(): boolean { return this.climb !== null; }

  /** 의자에 앉기 (제자리). 몸이 좌판 높이로 올라가고 그림자는 바닥에 남는다 */
  sitOn(seat: Seat): void {
    if (!this.sitAction) return;
    this.stop();
    this.seat = seat;
    // 발이 아니라 엉덩이가 좌판에 닿아야 한다 (안 그러면 의자 위에 올라선 모습이 된다).
    // 좌판에 살짝 얹히도록 아주 조금 띄운다
    this.liftTarget = this.seatLift(seat);
    this.targetYaw = seat.yaw;
    this.root.position.copy(toThree(seat.x, seat.y, 0));   // brain 이 좌판 앞까지 걸어온 뒤라 거의 제자리
    this.sitAction.reset().setEffectiveWeight(1).fadeIn(0.45).play();
  }

  /** 일어서기 (바닥으로 내려옴) */
  standUp(): void {
    if (!this.seat) return;
    this.seat = null;
    this.liftTarget = 0;
    this.sitAction?.fadeOut(0.4);
  }

  /** 표정 바꾸기 (face.ts) */
  setExpression(e: Expression): void {
    this.expression = e;
    this.face?.set(e);
  }
  get currentExpression(): Expression { return this.expression; }

  setState(s: RibbonState): void { this.state = s; }
  setMouthLevel(v: number): void {
    this.mouth = v;
    this.face?.setTalkLevel(v);
  }

  update(dt: number): void {
    this.t += dt;
    const climbing = this.stepClimb(dt);
    const moved = climbing ? 0 : this.stepMove(dt);
    // 앉고 일어설 때 몸만 오르내리고 그림자는 바닥에 둔다
    if (!climbing) this.lift = approach(this.lift, this.liftTarget, 1 - Math.exp(-dt * 6));
    this.root.position.y = this.lift;
    this.shadow.position.y = 0.008 - this.lift;
    this.shadow.scale.setScalar(this.shadowR * (1.1 + this.lift * 0.5));
    (this.shadow.material as THREE.Material).opacity = 0.2 * Math.max(0.35, 1 - this.lift);

    // 몸 방향
    if (this.targetYaw !== null && !this.path.length && !climbing) {
      const d = wrap(this.targetYaw - this.yaw);
      const step = TURN_RATE * dt;
      this.yaw += Math.abs(d) <= step ? d : Math.sign(d) * step;
      if (Math.abs(d) <= step) this.targetYaw = null;
    }
    this.root.rotation.y = this.yaw;

    // 액션
    const turning = this.targetYaw !== null;
    const wantWalk = (moved > 0 || turning) && !this.playing ? 1 : 0;
    this.walkWeight = approach(this.walkWeight, wantWalk, 1 - Math.exp(-dt * 8));
    if (this.walk) {
      this.walk.setEffectiveWeight(this.walkWeight);
      this.walk.timeScale = moved > 0 ? (moved / dt) / ANIM_WALK_SPEED : 0.8;
    }
    this.mixer?.update(dt);
    for (const b of this.bones.values()) { b.node.quaternion.copy(b.proxy.quaternion); b.node.position.copy(b.proxy.position); }
    this.procedural(dt);
    this.face?.update(dt);
  }

  /** 경로를 따라 이동. 이번 프레임에 간 거리 */
  private stepMove(dt: number): number {
    if (!this.path.length || this.playing || this.seat || this.held || this.climb) return 0;
    const target = this.path[0];
    const me = this.pos;
    const dx = target.x - me.x, dy = target.y - me.y;
    const dist = Math.hypot(dx, dy);
    const want = Math.atan2(dx, -dy);
    const diff = wrap(want - this.yaw);
    const turnStep = TURN_RATE * dt;
    this.yaw += Math.abs(diff) <= turnStep ? diff : Math.sign(diff) * turnStep;
    // 많이 틀어져 있으면 먼저 돌고 걷는다
    const k = Math.max(0, Math.cos(diff));
    const step = Math.min(dist, this.speed * dt * (0.25 + 0.75 * k));
    if (dist < 1e-4 || step >= dist) {
      this.root.position.copy(toThree(target.x, target.y));
      this.path.shift();
      if (!this.path.length) {
        const cb = this.onArrive; this.onArrive = null; cb?.();
      }
      return dist;
    }
    this.root.position.copy(toThree(me.x + (dx / dist) * step, me.y + (dy / dist) * step));
    return step;
  }

  /** 액션 위에 얹는 움직임. 동작(Nod·Tilt 등)이 재생 중이면 고개는 그 동작에 맡긴다 */
  private procedural(dt: number): void {
    const k = 1 - Math.exp(-dt * 6);
    this.motionBlend = approach(this.motionBlend, this.playing && this.playing !== "Wave" ? 0 : 1, 1 - Math.exp(-dt * 5));
    const s = this.state;
    // 고개: 보는 점 방향. 사람처럼 조금만 돌린다 (좌우 ±28°, 위아래 -17°~+11°)
    let yaw = 0, pitch = 0;
    if (this.gaze) {
      const head = this.bones.get("head")?.node;
      const from = head ? head.getWorldPosition(new THREE.Vector3()) : this.headTop();
      const d = this.gaze.clone().sub(from);
      yaw = THREE.MathUtils.clamp(wrap(Math.atan2(d.x, d.z) - this.yaw), -0.49, 0.49);
      pitch = THREE.MathUtils.clamp(-Math.atan2(d.y, Math.hypot(d.x, d.z)), -0.3, 0.2);
    }
    if (s === "thinking") { pitch -= 0.18; yaw += Math.sin(this.t * 0.8) * 0.1; }
    this.headYaw = approach(this.headYaw, yaw, k);
    this.headPitch = approach(this.headPitch, pitch, k);
    const tilt = s === "listening" ? 0.2 : s === "thinking" ? -0.14 : 0;
    this.tilt = approach(this.tilt, tilt, k);
    const talking = s === "speaking" ? this.mouth : 0;
    this.nod = approach(this.nod, talking, 1 - Math.exp(-dt * 18));

    const w = this.motionBlend;
    const head = this.bones.get("head")?.node;
    if (head) {
      head.rotateY(this.headYaw * w);
      head.rotateX((this.headPitch + this.nod * 0.18 + (s === "speaking" ? Math.sin(this.t * 9) * 0.03 * this.nod : 0)) * w);
      head.rotateZ(this.tilt * w);
    }
    const spine = this.bones.get("spine")?.node;
    if (spine) {
      spine.rotateY(this.headYaw * 0.4 * w);      // 고개만 꺾지 않고 몸도 같이 살짝 돌린다
      spine.rotateX(s === "listening" ? 0.08 * w : 0);
    }
    // 숨쉬기 + 말할 때 통통
    const breathe = Math.sin(this.t * 2.2) * 0.012;
    const bounce = this.nod * 0.03;
    this.body.scale.set(1 - breathe * 0.4, 1 + breathe + bounce, 1 - breathe * 0.4);
  }
}

/**
 * 모델을 위에서 봤을 때 몸 가운데 축(원점)에서 꼭짓점까지의 거리 중 99% 지점.
 * 맨 끝(리본 끝·머리카락 한 가닥)까지 넣으면 통로가 너무 좁아지고, 상자 폭의 일부만 쓰면 머리가 가구에 묻힌다.
 */
function horizontalRadius(model: THREE.Object3D): number {
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const v = new THREE.Vector3();
  const d: number[] = [];
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    const pos = m.isMesh && m.visible ? m.geometry.getAttribute("position") : null;
    if (!pos) return;
    const toModel = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    for (let i = 0; i < pos.count; i += 3) {       // 셋 중 하나만 봐도 충분하다
      v.fromBufferAttribute(pos, i).applyMatrix4(toModel);
      d.push(Math.hypot(v.x, v.z));
    }
  });
  if (!d.length) return 0;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length * 0.99)];
}

function shadowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(0,0,0,0.9)");
  grad.addColorStop(0.6, "rgba(0,0,0,0.4)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
