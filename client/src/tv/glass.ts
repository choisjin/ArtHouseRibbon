import * as THREE from "three";
import { Ribbon3D } from "./ribbon3d";

/**
 * 유리창 층: 캐릭터가 TV 화면(유리)에 바짝 붙어 우리 쪽을 들여다보는 모습.
 *
 * TV 카메라는 방 앞면에서 멀리(8m) 떨어져 눈높이에서 수평으로 보고 있어서, 방 안 캐릭터가 앞으로 나오면
 * 커지기 전에 화면 아래로 빠져나간다. 그래서 화면에 붙는 순간은 방과 따로 그린다:
 * 방 캐릭터가 화면 아래로 걸어 나가면(brain.ts), 같은 캐릭터 사본이 이 층에서 화면 아래로부터 크게 올라와
 * 유리에 손을 짚고 얼굴을 붙인 채 너머를 보려고 애쓴다 (좌우로 옮겨 가며 두리번, 까치발, 유리에 입김). 끝나면 내려간다.
 * 이 층은 방 위에 겹쳐 그린다 (깊이만 지우고). 조명은 방과 같은 환경맵.
 */

/** 붙어 있는 동안의 순서 (초). 올라오기 → 두리번 → 내려가기 */
const RISE = 0.9;
const HOLD = 5.4;
const SINK = 0.8;
/** 이 층 카메라에서 캐릭터까지 거리. 가까울수록 크게 보인다 */
const DIST = 4.6;

interface Actor {
  src: Ribbon3D;              // 방 안 캐릭터 (숨겨 둔다)
  doll: Ribbon3D;             // 이 층에 그리는 사본
  /** 사본을 옮기는 틀. 몸(doll.root)은 매 프레임 높이·방향을 스스로 정하므로 바깥 틀을 움직인다 */
  holder: THREE.Group;
  slot: number;               // 화면 가로 자리 (-1 ~ 1)
  t: number;
  phase: "rise" | "hold" | "sink";
  sinkFrom: number;
  fast: boolean;
  onGone: (() => void) | null;
  fog: HTMLDivElement;
  nextFog: number;
  fogT: number;
}

export class GlassLayer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 50);
  private actors: Actor[] = [];
  private copies = new Map<string, Ribbon3D>();   // 캐릭터별 사본 (한 번 읽어 두고 다시 쓴다)

  constructor(private view: () => { x: number; y: number; w: number; h: number }) {
    this.camera.position.set(0, 0, DIST);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xcdbba8, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.3);
    key.position.set(2, 4, 6);                       // 우리 쪽 위에서 비추는 빛 (방 창가 쪽 밝음)
    this.scene.add(key);
  }

  get active(): boolean { return this.actors.length > 0; }

  /** 이 층 카메라의 세로 화각에서, 거리 DIST 에 보이는 높이의 절반 */
  private get halfH(): number { return DIST * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)); }

  /**
   * 방 캐릭터 src 가 화면에 붙는다. roomX 는 방 안 가로 위치(여럿이면 그 순서대로 나란히 선다).
   * 다 보고 내려가면 onGone (방 캐릭터를 다시 보이게 할 때)
   */
  enter(src: Ribbon3D, roomX: number, onGone: () => void): void {
    if (this.actors.some((a) => a.src === src)) return;
    const id = src.spec.id;
    let doll = this.copies.get(id);
    if (!doll) {
      doll = new Ribbon3D(id);
      doll.root.getObjectByName("shadow")!.visible = false;
      this.copies.set(id, doll);
    }
    if (this.actors.some((a) => a.doll === doll)) { onGone(); return; }   // 같은 캐릭터 둘은 없다
    doll.setLook(src.currentLook);
    doll.stop();
    doll.setExpression("curious");
    doll.root.visible = true;
    doll.root.position.set(0, 0, 0);
    const holder = new THREE.Group();
    holder.add(doll.root);
    this.scene.add(holder);
    const fog = document.createElement("div");
    fog.className = "glass-fog";
    document.body.appendChild(fog);
    this.actors.push({ src, doll, holder, slot: roomX, t: 0, phase: "rise", sinkFrom: 0, fast: false, onGone, fog, nextFog: 1.3, fogT: -1 });
    src.root.visible = false;
    this.layout();
  }

  /** 먼저 내려가기 (불렸을 때). 빨리 내려간다 */
  leave(src: Ribbon3D): void {
    const a = this.actors.find((x) => x.src === src);
    if (!a || a.phase === "sink") return;
    a.fast = true;
    this.startSink(a);
  }

  isOn(src: Ribbon3D): boolean { return this.actors.some((a) => a.src === src); }

  /** 한 명이면 방 위치 비슷한 곳, 둘이면 왼쪽·오른쪽에 나란히 */
  private layout(): void {
    const byX = [...this.actors].sort((a, b) => a.slot - b.slot);
    const n = byX.length;
    byX.forEach((a, i) => {
      const x = n === 1 ? THREE.MathUtils.clamp(a.slot * 0.08, -0.9, 0.9) : (i - (n - 1) / 2) * 2.1;
      a.holder.position.x = x;
      a.holder.userData.baseX = x;
    });
  }

  private startSink(a: Actor): void {
    a.phase = "sink";
    a.t = 0;
    a.sinkFrom = a.holder.position.y;
    a.doll.lookAt(null);
  }

  update(dt: number): void {
    const H = this.halfH;
    const doll0 = [...this.copies.values()][0];
    const height = doll0?.height ?? 2.4;
    // 올라온 자리: 머리 꼭대기가 화면 아래에서 62% 쯤 (얼굴과 유리를 짚은 손이 다 보이고 몸은 아래로 잘린다)
    const upY = -H + 2 * H * 0.62 - height;
    const downY = -H - height - 0.2;
    for (const a of [...this.actors]) {
      a.t += dt;
      const d = a.doll, r = a.holder;
      const baseX = r.userData.baseX ?? 0;
      const head = (dx: number, dy: number) => new THREE.Vector3(baseX + dx, r.position.y + height * 0.75 + dy, DIST + 2);
      if (a.phase === "rise") {
        const k = easeOut(Math.min(1, a.t / RISE));
        r.position.y = downY + (upY - downY) * k;
        if (a.t > RISE * 0.55 && !d.motion) d.play("Peek", undefined, 0.8);    // 손을 올려 유리를 짚는다 (조금 느리게 오래)
        if (a.t >= RISE) { a.phase = "hold"; a.t = 0; }
      } else if (a.phase === "hold") {
        const t = a.t;
        // 두리번: 가운데 → 왼쪽으로 옮겨 가며 왼쪽 보기 → 오른쪽 → 까치발로 위 → 가운데
        let dx = 0, lift = 0, gx = 0, gy = 0;
        if (t < 0.8) { gx = 0; }
        else if (t < 1.9) { const k = smooth((t - 0.8) / 0.5); dx = -0.28 * k; gx = -3; }
        else if (t < 3.0) { const k = smooth((t - 1.9) / 0.6); dx = -0.28 + 0.56 * k; gx = 3; }
        else if (t < 4.3) { const k = Math.sin(Math.PI * Math.min(1, (t - 3.0) / 1.3)); dx = 0.28 * (1 - smooth((t - 3.0) / 0.5)); lift = 0.16 * k; gy = 1.6 * k; }
        else { gx = 0; }
        r.position.x = baseX + dx;
        r.position.y = upY + lift + Math.sin(a.t * 7) * 0.008;       // 까치발 + 발끝에서 아주 조금 흔들
        d.lookAt(head(gx, gy));
        // 유리에 눌린 느낌: 우리 쪽(앞뒤)으로 살짝 납작, 옆으로 살짝 넓게
        r.scale.set(1.035, 1, 0.9);
        if (t > HOLD || (a.fast && t > 0)) this.startSink(a);
        // 입김
        if (t > a.nextFog) { a.fogT = 0; a.nextFog = t + 1.8 + Math.random() * 0.8; }
      } else {
        const dur = a.fast ? SINK * 0.5 : SINK;
        const k = easeIn(Math.min(1, a.t / dur));
        r.position.y = a.sinkFrom + (downY - a.sinkFrom) * k;
        r.scale.set(1.035 - 0.035 * k, 1, 0.9 + 0.1 * k);
        if (a.t >= dur) this.remove(a);
      }
      d.update(dt);
      this.drawFog(a, dt, height);
    }
  }

  /** 입김: 입 앞 유리가 잠깐 뿌옇게 흐려졌다가 사라진다 (화면 위 DOM 한 겹) */
  private drawFog(a: Actor, dt: number, height: number): void {
    const el = a.fog;
    if (a.fogT < 0 || a.phase !== "hold") { el.style.opacity = "0"; return; }
    a.fogT += dt;
    const k = a.fogT < 0.3 ? a.fogT / 0.3 : Math.max(0, 1 - (a.fogT - 0.3) / 1.2);
    if (k <= 0 && a.fogT > 0.3) { a.fogT = -1; el.style.opacity = "0"; return; }
    const r = a.holder;
    const mouth = new THREE.Vector3(r.position.x, r.position.y + height * 0.5, 0.9).project(this.camera);
    const edge = new THREE.Vector3(r.position.x + 0.55, r.position.y + height * 0.5, 0.9).project(this.camera);
    const v = this.view();
    const x = v.x + (mouth.x + 1) / 2 * v.w, y = v.y + (1 - mouth.y) / 2 * v.h;
    const size = Math.max(40, Math.abs(edge.x - mouth.x) / 2 * v.w * 2);
    el.style.left = `${x - size / 2}px`;
    el.style.top = `${y - size * 0.35}px`;
    el.style.width = `${size}px`;
    el.style.height = `${size * 0.7}px`;
    el.style.opacity = String(0.55 * k);
  }

  private remove(a: Actor): void {
    this.actors = this.actors.filter((x) => x !== a);
    this.scene.remove(a.holder);
    a.holder.remove(a.doll.root);
    a.doll.stop();
    a.doll.cancelMotion();
    a.fog.remove();
    a.src.root.visible = true;
    const cb = a.onGone; a.onGone = null; cb?.();
    this.layout();
  }

  /** 방을 그린 뒤 이 층을 겹쳐 그린다 */
  render(renderer: THREE.WebGLRenderer, env: THREE.Texture | null, aspect: number): void {
    if (!this.active) return;
    this.scene.environment = env;
    if (this.camera.aspect !== aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = auto;
  }
}

const smooth = (x: number) => { const v = Math.min(1, Math.max(0, x)); return v * v * (3 - 2 * v); };
const easeOut = (x: number) => 1 - (1 - x) * (1 - x);
const easeIn = (x: number) => x * x;
