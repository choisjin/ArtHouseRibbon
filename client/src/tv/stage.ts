import * as THREE from "three";
import { NavGrid, type P2 } from "../world/nav";
import { RoomModel } from "../world/room";
import { rad, toThree, WORLD_BASE, type Catalog, type Layout, type RoomInfo } from "../world/types";

export async function fetchCatalog(): Promise<Catalog> {
  const res = await fetch(`${WORLD_BASE}catalog.json`);
  if (!res.ok) throw new Error(`맵 카탈로그가 없습니다 (${res.status}). tools/sync_world.py 를 실행하세요`);
  return res.json();
}

/**
 * TV 3D 화면: 렌더러, 조명, TV 카메라(블렌더 map 의 tv_camera 와 같은 시점), 방.
 * 창 비율이 16:9 가 아니면 세로 화각을 유지하고 좌우를 더 보이거나 자른다.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 500);
  readonly room: RoomModel;

  constructor(parent: HTMLElement, catalog: Catalog) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    parent.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x0e0b16);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xcdbba8, 2.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(6, 20, 12);
    this.scene.add(sun);
    this.room = new RoomModel(catalog);
    this.scene.add(this.room.group);
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 방의 tv_camera 로 카메라를 맞춘다 */
  fitCamera(room: RoomInfo): void {
    const t = room.tv_camera;
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(rad(t.hfov_deg) / 2) * 9 / 16));
    this.camera.position.copy(toThree(t.x, t.y, t.z));
    this.camera.lookAt(toThree(t.x, t.y + 10, t.z));
    this.camera.updateProjectionMatrix();
  }

  async setLayout(roomId: string, layout: Layout | null): Promise<boolean> {
    const changed = await this.room.setLayout(roomId, layout);
    if (changed && this.room.room) this.fitCamera(this.room.room);
    return changed;
  }

  /** 발과 머리 끝이 모두 화면 안쪽(가장자리 여백 margin)에 보이는 바닥 점인가 */
  onScreen(p: P2, height: number, margin = 0.06): boolean {
    const lim = 1 - margin;
    for (const z of [0, height]) {
      const v = toThree(p.x, p.y, z).project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > lim || Math.abs(v.y) > lim) return false;
    }
    return true;
  }

  buildNav(radius: number, height: number): NavGrid | null {
    const r = this.room;
    if (!r.room || !r.layout) return null;
    this.camera.updateMatrixWorld();
    return new NavGrid(r.room, r.types, r.layout, radius, 0.2, (p) => this.onScreen(p, height));
  }

  /** 월드 점의 화면 픽셀 좌표 */
  toScreen(p: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const v = p.clone().project(this.camera);
    return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight, visible: v.z < 1 };
  }

  render(): void { this.renderer.render(this.scene, this.camera); }
}
