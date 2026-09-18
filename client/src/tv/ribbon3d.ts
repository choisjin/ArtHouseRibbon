import * as THREE from "three";
import type { RibbonState } from "../protocol";
import { applyLook, loadDoll, type RibbonLook } from "../world/doll";
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
export type Motion = "Wave" | "Nod" | "Shake" | "Tilt" | "Sway" | "Stretch" | "Point" | "Clap" | "Jump" | "LookUp";

/** 앉을 자리: 바닥 좌표와 좌판 높이(장면 단위), 앉아서 바라보는 방향 */
export interface Seat { x: number; y: number; height: number; yaw: number }

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const approach = (cur: number, target: number, k: number) => cur + (target - cur) * k;

/**
 * 리본이 몸: doll.glb + Walk/Greet 액션 + 코드로 만드는 움직임(숨쉬기·고개 돌리기·말할 때 끄덕임).
 * 어디로 갈지는 brain.ts 가 정하고, 여기서는 받은 경로를 따라 걷고 돌아선다.
 * 좌표는 배치 파일 바닥 단위(P2). 정면은 three.js +Z (TV 카메라 쪽).
 */
export class Ribbon3D {
  readonly root = new THREE.Group();
  height = 2.4;
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
  private lift = 0;               // 바닥에서 띄운 높이 (앉으면 좌판 높이)
  private liftTarget = 0;
  private shadow: THREE.Mesh;
  private motionBlend = 1;
  private t = 0;
  state: RibbonState = "idle";
  loaded: Promise<void>;

  constructor() {
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
    const { scene, animations } = await loadDoll();
    this.model = scene;
    applyLook(scene, this.look);
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
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    this.height = size.y;
    this.radius = Math.max(size.x, size.z) * 0.4;   // 팔·치마 끝까지 넣으면 너무 넓다
    const shadow = this.root.getObjectByName("shadow")!;
    shadow.scale.setScalar(this.radius * 1.1);

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

  /** 동작 한 번. 걷는 중이면 하지 않는다 */
  play(name: Motion, onDone?: () => void): boolean {
    const a = this.motions.get(name);
    if (!a || this.moving || this.playing) { onDone?.(); return false; }
    this.playing = name;
    this.motionDone = onDone ?? null;
    a.reset().setEffectiveWeight(1).fadeIn(0.2).play();
    return true;
  }

  setLook(look: Partial<RibbonLook> | undefined): void {
    this.look = look;
    if (this.model) applyLook(this.model, look);
  }

  get pos(): P2 { return { x: this.root.position.x, y: -this.root.position.z }; }
  get moving(): boolean { return this.path.length > 0; }
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
  }

  walkPath(path: P2[], onArrive?: () => void): void {
    this.path = [...path];
    this.onArrive = onArrive ?? null;
    this.targetYaw = null;
  }

  stop(): void {
    this.path = [];
    this.onArrive = null;
  }

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

  /** 의자에 앉기. 몸이 좌판 높이로 올라가고 그림자는 바닥에 남는다 */
  sitOn(seat: Seat): void {
    if (!this.sitAction) return;
    this.stop();
    this.seat = seat;
    this.liftTarget = seat.height;
    this.targetYaw = seat.yaw;
    this.root.position.copy(toThree(seat.x, seat.y, 0));
    this.sitAction.reset().setEffectiveWeight(1).fadeIn(0.45).play();
  }

  /** 일어서기 (바닥으로 내려옴) */
  standUp(): void {
    if (!this.seat) return;
    this.seat = null;
    this.liftTarget = 0;
    this.sitAction?.fadeOut(0.4);
  }

  setState(s: RibbonState): void { this.state = s; }
  setMouthLevel(v: number): void { this.mouth = v; }

  update(dt: number): void {
    this.t += dt;
    const moved = this.stepMove(dt);
    // 앉고 일어설 때 몸만 오르내리고 그림자는 바닥에 둔다
    this.lift = approach(this.lift, this.liftTarget, 1 - Math.exp(-dt * 6));
    this.root.position.y = this.lift;
    this.shadow.position.y = 0.008 - this.lift;
    this.shadow.scale.setScalar(this.radius * (1.1 + this.lift * 0.5));
    (this.shadow.material as THREE.Material).opacity = 0.2 * Math.max(0.35, 1 - this.lift);

    // 몸 방향
    if (this.targetYaw !== null && !this.path.length) {
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
  }

  /** 경로를 따라 이동. 이번 프레임에 간 거리 */
  private stepMove(dt: number): number {
    if (!this.path.length || this.playing || this.seat) return 0;
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
    // 고개: 보는 점 방향 (몸 기준 좌우 ±70°, 위아래 ±25°)
    let yaw = 0, pitch = 0;
    if (this.gaze) {
      const head = this.bones.get("head")?.node;
      const from = head ? head.getWorldPosition(new THREE.Vector3()) : this.headTop();
      const d = this.gaze.clone().sub(from);
      yaw = THREE.MathUtils.clamp(wrap(Math.atan2(d.x, d.z) - this.yaw), -1.2, 1.2);
      pitch = THREE.MathUtils.clamp(-Math.atan2(d.y, Math.hypot(d.x, d.z)), -0.45, 0.35);
    }
    if (s === "thinking") { pitch -= 0.25; yaw += Math.sin(this.t * 0.8) * 0.15; }
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
      spine.rotateY(this.headYaw * 0.25 * w);
      spine.rotateX(s === "listening" ? 0.08 * w : 0);
    }
    // 숨쉬기 + 말할 때 통통
    const breathe = Math.sin(this.t * 2.2) * 0.012;
    const bounce = this.nod * 0.03;
    this.body.scale.set(1 - breathe * 0.4, 1 + breathe + bounce, 1 - breathe * 0.4);
  }
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
