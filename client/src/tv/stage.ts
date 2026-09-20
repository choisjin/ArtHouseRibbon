import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { NavGrid, type P2 } from "../world/nav";
import { RoomModel, type WallMount } from "../world/room";
import { FLOOR_LAYER, rad, toThree, WORLD_BASE, type Catalog, type Layout, type RoomInfo, type WorldRender } from "../world/types";

export async function fetchCatalog(): Promise<Catalog> {
  const res = await fetch(`${WORLD_BASE}catalog.json`);
  if (!res.ok) throw new Error(`맵 카탈로그가 없습니다 (${res.status}). tools/sync_world.py 를 실행하세요`);
  return res.json();
}

/** 가림막: 색은 안 칠하고 깊이만 남겨서 리본이가 가구 뒤로 가면 가려지게 */
const OCCLUDER = new THREE.MeshBasicMaterial({ colorWrite: false });

/**
 * TV 3D 화면. 두 가지 방식:
 *
 * - **렌더 배경**(기본, 서버에 블렌더 렌더가 있을 때): 블렌더가 그린 방 사진을 배경으로 깔고 리본이만 실시간으로 그린다.
 *   방 모델은 깊이만 그리는 가림막으로 두고, 바닥에는 그림자만 받는 판을 깐다. 리본이 조명은 같이 렌더한 360° HDR.
 *   카메라가 블렌더와 똑같아야 하므로 화면은 16:9 로 고정(남는 곳은 검은 띠).
 * - **실시간**(렌더가 없을 때): 방까지 three.js 로 그린다.
 */
/** 걸린 그림(액자·그림면)의 부품인가. 그림 무리에 userData.art 가 붙어 있다 (world/room.ts) */
function isArt(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.art) return true;
  return false;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 500);
  readonly room: RoomModel;
  mode: "render" | "live" = "live";
  /** 걸린 그림을 배경 위에 실시간으로 그린다 (아이 전시실: 배경은 그림 없는 전시실 한 장을 같이 쓴다) */
  liveArts = false;
  private hemi = new THREE.HemisphereLight(0xffffff, 0xcdbba8, 2.4);
  private sun = new THREE.DirectionalLight(0xffffff, 1.6);
  private shadowFloor: THREE.Mesh;
  private bgKey = "";
  private renderBg: THREE.Texture | null = null;
  private envKey = "";
  private renderEnv: THREE.Texture | null = null;
  private view = { x: 0, y: 0, w: 1, h: 1 };
  private wallView: WallMount | null = null;

  constructor(parent: HTMLElement, catalog: Catalog) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = this.renderer.domElement;
    canvas.style.position = "absolute";
    parent.appendChild(canvas);
    this.scene.background = new THREE.Color(0x0e0b16);
    this.sun.position.set(6, 20, 12);
    this.sun.castShadow = true;
    // 그림자는 리본이 주변만 (followShadow): 좁은 범위라 선명하고, 어느 GPU 에서도 같은 모양
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.001;
    this.sun.shadow.normalBias = 0.02;
    const sc = this.sun.shadow.camera;
    sc.left = -3; sc.right = 3; sc.top = 3; sc.bottom = -3; sc.near = 1; sc.far = 40;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.22 }));
    this.shadowFloor.rotation.x = -Math.PI / 2;
    this.shadowFloor.position.y = 0.004;
    this.shadowFloor.receiveShadow = true;
    this.shadowFloor.visible = false;
    this.scene.add(this.shadowFloor);
    this.room = new RoomModel(catalog);
    this.scene.add(this.room.group);
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  /** 렌더 배경이면 16:9 로 가운데 맞춤, 실시간이면 창 전체 */
  resize(): void {
    const W = window.innerWidth, H = window.innerHeight;
    let w = W, h = H;
    if (this.mode === "render") {
      h = Math.round(W * 9 / 16);
      if (h > H) { h = H; w = Math.round(H * 16 / 9); }
    }
    this.view = { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
    const c = this.renderer.domElement;
    c.style.left = `${this.view.x}px`;
    c.style.top = `${this.view.y}px`;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.wallView) this.applyWallView();
  }

  /**
   * 벽 하나를 정면에서 본다 (전시실 꾸미기·부모님 전시실의 '왼쪽 벽 / 오른쪽 벽'). null 이면 TV 카메라로 돌아간다.
   * 배경 렌더는 TV 카메라에서 찍은 한 장뿐이라, 돌려 볼 때는 부르는 쪽이 렌더 없이(setWorld 의 render=null) 실시간으로 그린다
   */
  faceWall(w: WallMount | null): void {
    this.wallView = w;
    if (w) this.applyWallView();
    else if (this.room.room) this.fitCamera(this.room.room);
  }

  /** 벽이 화면에 꽉 차게 카메라를 벽 앞에 세운다. 방이 좁아 뒤로 못 물러나면 화각을 넓힌다 */
  private applyWallView(): void {
    const w = this.wallView;
    const room = this.room.room;
    if (!w || !room) return;
    const MARGIN = 1.24;                        // 위아래에 메뉴가 덮이므로 벽 둘레를 넉넉히 남긴다
    const aspect = this.camera.aspect;
    let vfov = rad(46);
    const need = (f: number) => Math.max(w.height / 2 / Math.tan(f / 2), w.width / 2 / (Math.tan(f / 2) * aspect)) * MARGIN;
    const reach = Math.abs(w.normal.x) * room.width + Math.abs(w.normal.z) * room.depth - 0.4;   // 맞은편 벽 바로 앞까지
    let d = need(vfov);
    if (reach > 1 && d > reach) {
      d = reach;
      vfov = Math.min(rad(100), 2 * Math.atan(Math.max(w.height / 2, w.width / 2 / aspect) * MARGIN / d));
    }
    const center = w.o.clone().addScaledVector(w.up, w.height / 2);
    this.camera.fov = THREE.MathUtils.radToDeg(vfov);
    this.camera.position.copy(center).addScaledVector(w.normal, d);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
  }

  /** 방의 tv_camera 로 카메라를 맞춘다 (블렌더 TVCam 과 같은 위치·화각) */
  fitCamera(room: RoomInfo): void {
    const t = room.tv_camera;
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(rad(t.hfov_deg) / 2) * 9 / 16));
    this.camera.position.copy(toThree(t.x, t.y, t.z));
    this.camera.lookAt(toThree(t.x, t.y + 10, t.z));
    this.camera.updateProjectionMatrix();
    this.sun.shadow.camera.updateProjectionMatrix();
    this.shadowFloor.scale.set(room.width, room.depth, 1);
    if (this.wallView) this.applyWallView();
  }

  /** 그림자 빛을 리본이 머리 위(조금 앞)에 둔다. 방 천장 조명처럼 거의 바로 아래로 떨어짐 */
  followShadow(p: THREE.Vector3): void {
    this.sun.target.position.copy(p);
    this.sun.position.set(p.x + 0.8, p.y + 14, p.z + 2.5);
  }

  /**
   * 방을 맞춘다. 렌더가 있으면 렌더에 쓴 배치로 가림막을 짓고 배경을 바꾼다.
   * 배경·조명·가구를 모두 읽은 뒤 한 번에 바꾼다 (배경만 먼저 바뀌어 옛 방 길로 걷는 일이 없게).
   * 방 모양(가림막·길찾기)이 바뀌었으면 changed, 다른 방이 됐으면 roomChanged
   */
  async setWorld(roomId: string, layout: Layout | null, render: WorldRender | null | undefined): Promise<{ changed: boolean; roomChanged: boolean }> {
    const useRender = !!render?.bg;
    const lay = useRender ? render!.layout ?? layout : layout;
    const liveArts = useRender && !!render!.arts_live;
    const roomChanged = !!this.room.roomId && roomId !== this.room.roomId;
    const [bg, env] = useRender
      ? await Promise.all([this.loadBackground(render!.bg), this.loadEnvironment(render!.env)])
      : [null, null];
    const changed = await this.room.setLayout(roomId, lay);
    const modeChanged = (useRender ? "render" : "live") !== this.mode || liveArts !== this.liveArts;
    this.liveArts = liveArts;
    if (useRender) {
      if (bg !== this.renderBg) { this.renderBg?.dispose(); this.renderBg = bg; }
      if (env !== this.renderEnv) { this.renderEnv?.dispose(); this.renderEnv = env; }
    }
    if (changed || modeChanged || useRender) {
      this.mode = useRender ? "render" : "live";
      this.applyMode();
    }
    if (changed || modeChanged) {
      if (this.room.room) this.fitCamera(this.room.room);
      this.resize();
    }
    this.setLight(lay?.light ?? 1);
    return { changed: changed || modeChanged, roomChanged };
  }

  /**
   * 전시실 조명 밝기 (1 = 그대로). 배경 그림은 톤매핑을 거치지 않으므로 따로 어둡게 하고,
   * 실시간으로 그리는 것(걸린 그림·캐릭터)은 노출로 같이 맞춘다
   */
  setLight(level: number): void {
    const v = Math.min(1.6, Math.max(0.2, level));
    this.scene.backgroundIntensity = v;
    this.renderer.toneMappingExposure = v;
  }

  private async loadBackground(url: string): Promise<THREE.Texture> {
    if (url === this.bgKey && this.renderBg) return this.renderBg;
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.bgKey = url;
    return tex;
  }

  private async loadEnvironment(url: string | null): Promise<THREE.Texture | null> {
    if (!url) return null;
    if (url === this.envKey && this.renderEnv) return this.renderEnv;
    try {
      const hdr = await new RGBELoader().loadAsync(url);
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const env = pmrem.fromEquirectangular(hdr).texture;
      pmrem.dispose();
      hdr.dispose();
      this.envKey = url;
      return env;
    } catch (e) {
      console.warn("환경 HDR 을 못 읽음", url, e);
      return null;
    }
  }

  private applyMode(): void {
    const render = this.mode === "render";
    const r = this.renderer;
    r.toneMapping = render ? THREE.AgXToneMapping : THREE.NeutralToneMapping;   // 블렌더 AgX 와 맞춤
    r.toneMappingExposure = 1;
    this.scene.background = render && this.renderBg ? this.renderBg : new THREE.Color(0x0e0b16);
    this.scene.environment = render ? this.renderEnv : null;
    this.hemi.intensity = render ? 0.25 : 2.4;
    this.sun.intensity = render ? 0.6 : 1.6;
    this.shadowFloor.visible = render;
    this.room.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // 배경에 이미 찍혀 있는 것은 깊이만 그리는 가림막으로. 실시간으로 그릴 그림은 그대로 둔다
      const occlude = render && !(this.liveArts && isArt(m));
      if (occlude) {
        if (!m.userData.liveMaterial) {
          m.userData.liveMaterial = m.material;
          m.userData.liveVisible = m.visible;       // 그림이 걸린 이젤은 원래 캔버스가 숨겨져 있다
        }
        m.material = OCCLUDER;
        m.renderOrder = -1;
        // 바닥과 바닥에 깔린 것은 가림막이 아니다 (그림자판·발이 묻힌다)
        m.visible = m.userData.liveVisible && !(/^Floor/.test(m.name) || this.isFlat(m));
      } else if (m.userData.liveMaterial) {
        m.material = m.userData.liveMaterial;
        m.visible = m.userData.liveVisible;
        m.renderOrder = 0;
        delete m.userData.liveMaterial;
      }
    });
  }

  /** 러그처럼 바닥에 깔린 가구의 부품인가 */
  private isFlat(o: THREE.Object3D): boolean {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) {
      const id = p.userData.itemId as string | undefined;
      if (!id) continue;
      const e = this.room.layout?.items.find((i) => i.id === id);
      const t = e && this.room.types.get(e.type);
      return !!e && (FLOOR_LAYER.has(e.type) || (!!t && t.bbox.z1 < 0.15));
    }
    return false;
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

  /** 월드 점의 화면(창) 픽셀 좌표 */
  toScreen(p: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const v = p.clone().project(this.camera);
    return {
      x: this.view.x + (v.x + 1) / 2 * this.view.w,
      y: this.view.y + (1 - v.y) / 2 * this.view.h,
      visible: v.z < 1,
    };
  }

  render(): void { this.renderer.render(this.scene, this.camera); }
}
