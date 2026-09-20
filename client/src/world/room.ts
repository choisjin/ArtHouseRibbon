import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  b2t, rad, toThree, WORLD_BASE,
  type Catalog, type Layout, type LayoutArt, type LayoutItem, type MountSpec, type RoomInfo, type TypeInfo,
} from "./types";

/**
 * TV 가 그리는 방: 방 껍데기(벽·바닥·천장) + 배치된 가구 + 걸린 그림.
 * 계산 방식은 배치 편집기(editor/app.js)와 같다. 편집기에서 저장하면 서버 state 로 새 배치가 오고 setLayout 으로 다시 짓는다.
 */

type V3 = [number, number, number];
const FRAMES: Record<string, [number, number, number | null]> = {
  canvas: [0, 0, null], black: [20, 38, 0x1d1d1f], wood: [40, 42, 0xa8744a], white: [30, 38, 0xf6f5f1],
};
const ART_DEPTH_MM = 30;

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

function texture(file: string): THREE.Texture {
  let t = texCache.get(file);
  if (!t) {
    t = new THREE.TextureLoader().load(`/${file}`);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    texCache.set(file, t);
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
    const fw = ((FRAMES[a.frame ?? "canvas"] ?? FRAMES.canvas)[0] / 1000) * U;
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
    const D = MM(ART_DEPTH_MM);
    const [fwmm, fdmm, fcol] = FRAMES[a.frame ?? "canvas"] ?? FRAMES.canvas;
    const fw = MM(fwmm), fd = MM(fdmm);
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, D),
      new THREE.MeshStandardMaterial({ color: fcol === null ? 0xf4f1ea : 0x3c3a38, roughness: 0.8 }));
    body.position.z = D / 2;
    g.add(body);
    if (fcol !== null) {
      const fm = new THREE.MeshStandardMaterial({ color: fcol, roughness: 0.45 });
      for (const [cx, cy, sx, sy] of [[0, h / 2 + fw / 2, w + 2 * fw, fw], [0, -h / 2 - fw / 2, w + 2 * fw, fw],
        [-w / 2 - fw / 2, 0, fw, h], [w / 2 + fw / 2, 0, fw, h]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, fd), fm);
        bar.position.set(cx, cy, fd / 2);
        g.add(bar);
      }
    }
    const img = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({ map: texture(a.image), roughness: 0.6 }));
    img.position.z = D + MM(1);
    g.add(img);
    g.matrixAutoUpdate = false;
    g.matrix.copy(basis(m, c));
    return g;
  }
}
