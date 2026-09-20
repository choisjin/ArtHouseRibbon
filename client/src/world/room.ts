import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  b2t, rad, toThree, WORLD_BASE,
  type Catalog, type Layout, type LayoutArt, type LayoutItem, type MountSpec, type RoomInfo, type TypeInfo,
} from "./types";
import { bgOf, composeArt, padOf } from "./artimage";
import { buildFrame, frameReach, frameStyle } from "./frames";
import { buildLamp, lampColor, lampOf } from "./lamp";

/**
 * TV 가 그리는 방: 방 껍데기(벽·바닥·천장) + 배치된 가구 + 걸린 그림.
 * 계산 방식은 배치 편집기(editor/app.js)와 같다. 편집기에서 저장하면 서버 state 로 새 배치가 오고 setLayout 으로 다시 짓는다.
 */

type V3 = [number, number, number];
/** 전시장 천장의 레일 조명 (방 뼈대 glb 에 들어 있다). 작품마다 핀 조명을 따로 달면서 뺐다 (world/lamp.ts) */
const SHELL_HIDE = /^Ceiling(Track|Spot)/;
/** 핀 조명을 받은 그림이 스스로 밝아지는 정도 (조도 1 일 때) */
const LAMP_GLOW = 0.55;

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const rotZ = (v: V3, deg: number): V3 => {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
};

export interface Mount { host: string | null; spec: MountSpec; o: V3; n: V3; up: V3; right: V3 }

/** 그림을 걸 수 있는 면 하나 (three 좌표). o 는 면 가운데, right/up 은 면 위 방향, normal 은 바깥쪽 */
export interface WallMount {
  key: string; host: string | null; id: string; name: string;
  width: number; height: number; defaultSize?: number;
  o: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3; normal: THREE.Vector3;
}

/** 그림이 걸린 자리 (리본이 구경하러 가는 곳) */
export interface ArtSpot { id: string; center: THREE.Vector3; normal: THREE.Vector3 }

const loader = new GLTFLoader();
const modelCache = new Map<string, Promise<THREE.Object3D>>();
const texCache = new Map<string, THREE.Texture>();

export function loadModel(file: string): Promise<THREE.Object3D> {
  let p = modelCache.get(file);
  if (!p) {
    p = loader.loadAsync(WORLD_BASE + file).then((g) => g.scene);
    modelCache.set(file, p);
  }
  return p;
}

const ART_TEX_SIDE = 2048;       // 벽에 거는 그림면의 가장 큰 변 (px)

/** 그림면: 배경을 지운 작품이 검게 나오지 않도록 배경색(기본 흰색)을 깔고 여백을 둔다 (world/artimage.ts) */
function texture(a: LayoutArt): THREE.Texture {
  const key = `${a.image}|${bgOf(a)}|${padOf(a).join(",")}`;
  let t = texCache.get(key);
  if (!t) {
    // 그림이 읽힐 때까지는 비워 둔다 (TextureLoader 와 같다). 작은 임시 그림을 먼저 올렸다가 바꾸면
    // 밉맵이 임시 크기로 잡혀서, 비스듬히 본 그림이 검게 나온다
    const tex = new THREE.Texture();
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const img = new Image();
    img.onload = () => {
      tex.image = composeArt(img, img.naturalWidth, img.naturalHeight, a, ART_TEX_SIDE);
      tex.needsUpdate = true;
    };
    img.src = `/${a.image}`;
    t = tex;
    texCache.set(key, t);
  }
  return t;
}

function makeMount(host: string | null, spec: MountSpec, e: { x: number; y: number; rot: number }): Mount {
  const o = add(rotZ(spec.origin, e.rot), [e.x, e.y, 0]);
  const n = norm(rotZ(spec.normal, e.rot));
  let up = norm(rotZ(spec.up, e.rot));
  const right = norm(cross(up, n));
  up = norm(cross(n, right));
  return { host, spec, o, n, up, right };
}

function basis(m: Mount, c: V3): THREE.Matrix4 {
  const m4 = new THREE.Matrix4().makeBasis(b2t(m.right), b2t(m.up), b2t(m.n));
  m4.setPosition(b2t(c));
  return m4;
}

/** 그림 액자만 직접 만든 기하라 버린다. 가구는 캐시 모델을 복제해 기하·재질을 공유하므로 두면 된다 */
function disposeArts(g: THREE.Object3D): void {
  for (const c of g.children) if (c.userData.art) dispose(c);
}

function dispose(g: THREE.Object3D): void {
  g.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material as THREE.Material | undefined;
    if (mat && !Array.isArray(mat)) mat.dispose();
  });
}

export class RoomModel {
  readonly group = new THREE.Group();
  room: RoomInfo | null = null;
  roomId = "";
  types = new Map<string, TypeInfo>();
  layout: Layout | null = null;
  artSpots: ArtSpot[] = [];
  private shell: THREE.Object3D | null = null;
  private content = new THREE.Group();
  private sig = "";
  private version = 0;

  constructor(private catalog: Catalog) {
    for (const t of catalog.types) this.types.set(t.id, t);
    this.group.add(this.content);
  }

  get U(): number { return this.room?.unit_per_m ?? 2.2222; }

  private exposure = 1;
  /** 방 밝기(노출)가 바뀌었다: 핀 조명을 받은 그림은 방이 어두워져도 같은 밝기로 빛나게 맞춘다 (Stage.setLight) */
  setExposure(v: number): void {
    this.exposure = Math.max(0.05, v);
    this.group.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (mat && !Array.isArray(mat) && mat.userData?.glow) mat.emissiveIntensity = mat.userData.glow / this.exposure;
    });
  }

  /** 방/배치가 바뀌었으면 다시 짓는다. 바뀌었으면 true */
  async setLayout(roomId: string, layout: Layout | null): Promise<boolean> {
    // 아이 전시실처럼 남의 방 모양을 빌려 쓰는 방은 layout.shell 이 진짜 방을 가리킨다
    const room = this.catalog.rooms[layout?.shell ?? roomId] ?? this.catalog.rooms[roomId]
      ?? Object.values(this.catalog.rooms)[0];
    if (!room) return false;
    const lay = layout ?? this.catalog.default_layouts?.[room.id] ?? this.catalog.default_layout ?? null;
    if (!lay) return false;
    const sig = JSON.stringify([room.id, lay]);
    if (sig === this.sig) return false;
    this.sig = sig;
    const v = ++this.version;

    if (room.id !== this.roomId) {
      const shell = (await loadModel(room.shell)).clone(true);
      if (v !== this.version) return false;
      const gone: THREE.Object3D[] = [];
      shell.traverse((o) => { if (SHELL_HIDE.test(o.name)) gone.push(o); });
      for (const o of gone) o.removeFromParent();
      if (this.shell) this.group.remove(this.shell);
      this.shell = shell;
      this.group.add(shell);
    }
    this.room = room;
    this.roomId = room.id;
    this.layout = lay;

    const next = new THREE.Group();
    const mounts = new Map<string, Mount>();
    for (const m of room.mounts ?? []) mounts.set(`#room:${m.id}`, makeMount(null, m, { x: 0, y: 0, rot: 0 }));
    for (const e of lay.items) {
      for (const m of this.types.get(e.type)?.mounts ?? []) mounts.set(`${e.id}:${m.id}`, makeMount(e.id, m, e));
    }
    const hides = new Map<string, string[]>();
    const arts = lay.arts ?? [];
    for (const a of arts) {
      const m = mounts.get(`${a.mount.host ?? "#room"}:${a.mount.id}`);
      if (m?.host && m.spec.hides?.length) hides.set(m.host, [...(hides.get(m.host) ?? []), ...m.spec.hides]);
    }
    await Promise.all(lay.items.map((e) => this.addItem(next, e, hides.get(e.id) ?? [])));
    if (v !== this.version) return false;

    this.artSpots = [];
    for (const a of arts) {
      const m = mounts.get(`${a.mount.host ?? "#room"}:${a.mount.id}`);
      if (!m) continue;
      const c = this.artCenter(a, m);
      next.add(this.buildArt(a, m, c));
      this.artSpots.push({ id: a.id, center: b2t(c), normal: b2t(m.n) });
    }
    this.group.remove(this.content);
    disposeArts(this.content);
    this.content = next;
    this.group.add(next);
    return true;
  }

  private async addItem(parent: THREE.Group, e: LayoutItem, hide: string[]): Promise<void> {
    const t = this.types.get(e.type);
    if (!t) return;
    try {
      const model = (await loadModel(t.file)).clone(true);
      if (hide.length) {
        model.traverse((o) => { if (o !== model && hide.some((p) => o.name.startsWith(p))) o.visible = false; });
      }
      model.position.copy(toThree(e.x, e.y));
      model.rotation.set(0, rad(e.rot), 0);
      model.userData.itemId = e.id;
      parent.add(model);
    } catch (err) {
      console.warn("가구 모델을 불러오지 못함", t.file, err);
    }
  }

  /** 그림을 걸 수 있는 면들 (three 좌표). 전시실 꾸미기(?mode=art)가 여기에 대고 끌어 놓는다 */
  wallMounts(): WallMount[] {
    const lay = this.layout;
    if (!lay) return [];
    const out: WallMount[] = [];
    const add = (host: string | null, spec: MountSpec, e: { x: number; y: number; rot: number }): void => {
      if (spec.ledge) return;                        // 받침대(이젤)는 자리가 하나라 끌어 놓지 않는다
      const m = makeMount(host, spec, e);
      out.push({ key: `${host ?? "#room"}:${spec.id}`, host, id: spec.id, name: spec.name,
                 width: spec.width, height: spec.height, defaultSize: spec.default_size,
                 o: b2t(m.o), right: b2t(m.right), up: b2t(m.up), normal: b2t(m.n) });
    };
    for (const m of this.room?.mounts ?? []) add(null, m, { x: 0, y: 0, rot: 0 });
    for (const e of lay.items) {
      for (const m of this.types.get(e.type)?.mounts ?? []) add(e.id, m, e);
    }
    return out;
  }

  private artCenter(a: LayoutArt, m: Mount): V3 {
    const U = this.U;
    const w = a.width * U, h = w * a.aspect;
    const fw = (frameReach(frameStyle(a.frame)) / 1000) * U;
    const u = (a.u ?? 0) * U;
    const v = m.spec.ledge ? h / 2 + fw : (a.v ?? 1.5) * U;
    return add(m.o, add(mul(m.right, u), mul(m.up, v)));
  }

  private buildArt(a: LayoutArt, m: Mount, c: V3): THREE.Group {
    const U = this.U;
    const MM = (v: number) => (v / 1000) * U;
    const g = new THREE.Group();
    g.userData.art = a.id;
    const w = a.width * U, h = w * a.aspect;
    // 그림과 액자는 'art-core' 에 모은다 (전시실 꾸미기가 고른 그림의 테두리를 여기에 맞춘다. 핀 조명은 빼고)
    const core = new THREE.Group();
    core.name = "art-core";
    const frame = buildFrame(w, h, frameStyle(a.frame), MM);
    core.add(...frame.meshes);
    g.add(frame.shade);
    const lamp = m.host === null && !m.spec.ledge ? lampOf(a.lamp) : null;   // 핀 조명은 방의 벽에 건 그림만
    const mat = new THREE.MeshStandardMaterial({ map: texture(a), roughness: 0.6 });
    if (lamp?.on && lamp.power > 0) {
      // 빛을 받은 만큼 그림이 스스로 밝아진다 (방 밝기를 낮춰도 그림은 살아 있게, setExposure 가 맞춘다)
      mat.emissive = lampColor(lamp.tone);
      mat.emissiveMap = mat.map;
      mat.userData.glow = LAMP_GLOW * lamp.power;
      mat.emissiveIntensity = mat.userData.glow / this.exposure;
    }
    const img = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    img.position.z = frame.pictureZ + MM(1);
    core.add(img);
    g.add(core);
    if (lamp) {
      const drop = m.spec.height - (c[0] - m.o[0]) * m.up[0] - (c[1] - m.o[1]) * m.up[1] - (c[2] - m.o[2]) * m.up[2];
      const fixture = buildLamp(lamp, drop, MM);
      if (fixture) g.add(fixture);
    }
    g.matrixAutoUpdate = false;
    g.matrix.copy(basis(m, c));
    return g;
  }
}
