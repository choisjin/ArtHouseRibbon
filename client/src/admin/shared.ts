import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { AppConfig, KidInfo, StateMsg } from "../protocol";
import type { RibbonSocket } from "../ws";
import { Ribbon3D } from "../tv/ribbon3d";
import type { RibbonLook } from "../world/doll";

/** 탭들이 같이 쓰는 것: 서버 소켓, 마지막 상태, 알림 */
export interface AdminCtx {
  socket: RibbonSocket;
  kids(): KidInfo[];
  config(): AppConfig | null;
  state(): StateMsg | null;
  /** state 가 올 때마다 (처음 등록할 때 마지막 state 로 한 번 부른다) */
  onState(fn: (s: StateMsg) => void): void;
  msg(text: string, err?: boolean): void;
  /** 다른 탭으로 옮기기 (예: 대시보드에서 아이 설정으로) */
  go(hash: string): void;
}

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try { detail = JSON.parse(text).detail ?? text; } catch { /* 글자 그대로 */ }
    throw new Error(String(detail));
  }
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("json") ? await res.json() : await res.blob()) as T;
}

export const esc = (s: string | null | undefined): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export const VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];
export const voiceName = (v: string): string => (v.startsWith("F") ? `여성 ${v}` : `남성 ${v}`);
export const DAYS = ["월", "화", "수", "목", "금", "토", "일"];

/** 아이를 부르는 이름: 별명이 있으면 "이름(별명)" */
export const kidLabel = (k: KidInfo): string => (k.nickname && k.nickname !== k.name ? `${k.name}(${k.nickname})` : k.name);

// ---- 날짜 (브라우저 현지 시각 기준, 서버와 같은 YYYY-MM-DD) ----
export const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const parseYmd = (s: string): Date => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** 그 주 월요일 */
export const monday = (d: Date): Date => addDays(d, -((d.getDay() + 6) % 7));
/** 0=월 ... 6=일 */
export const weekday = (d: Date): number => (d.getDay() + 6) % 7;
export const toMin = (hhmm: string): number => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
export const toHhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** 생일로 만 나이 */
export function ageOf(k: KidInfo, today = new Date()): number | null {
  if (!k.birthday) return k.age ?? null;
  const b = parseYmd(k.birthday);
  let a = today.getFullYear() - b.getFullYear();
  if (today.getMonth() < b.getMonth() || (today.getMonth() === b.getMonth() && today.getDate() < b.getDate())) a--;
  return a;
}

/** 3D 미리보기: 천천히 도는 받침 위에 인형 하나 (드래그로 돌려 보기) */
export function mountPreview(el: HTMLElement, character: string, W = 240, H = 300): Ribbon3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.AgXToneMapping;
  el.innerHTML = "";
  el.appendChild(renderer.domElement);
  const { scene, camera } = previewScene(renderer, W / H);
  const doll = new Ribbon3D(character);
  const turntable = new THREE.Group();
  turntable.add(doll.root);
  scene.add(turntable);
  void doll.loaded.then(() => frameDoll(camera, doll));
  let drag: number | null = null;
  let spin = 0;
  renderer.domElement.title = "드래그해서 돌려 보기";
  renderer.domElement.onpointerdown = (e) => { drag = e.clientX; renderer.domElement.setPointerCapture(e.pointerId); };
  renderer.domElement.onpointermove = (e) => { if (drag !== null) { spin += (e.clientX - drag) * 0.01; drag = e.clientX; } };
  renderer.domElement.onpointerup = () => { drag = null; };
  const clock = new THREE.Clock();
  const tick = () => {
    if (!renderer.domElement.isConnected) { renderer.dispose(); return; }   // 화면에서 빠지면 멈춘다
    const dt = Math.min(clock.getDelta(), 0.1);
    if (drag === null) spin += dt * 0.35;
    turntable.rotation.y = Math.sin(spin) * 0.9;
    doll.update(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return doll;
}

function previewScene(renderer: THREE.WebGLRenderer, aspect: number) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1626);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xcdbba8, 0.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(3, 8, 6);
  scene.add(sun);
  return { scene, camera: new THREE.PerspectiveCamera(30, aspect, 0.05, 50) };
}

function frameDoll(camera: THREE.PerspectiveCamera, doll: Ribbon3D): void {
  const h = doll.height;
  camera.position.set(0, h * 0.62, h * 2.6);
  camera.lookAt(0, h * 0.48, 0);
}

/** 프로필 카드용 정지 사진. 렌더러 하나로 차례차례 찍는다 */
let shotQueue: Promise<unknown> = Promise.resolve();
export function snapshot(character: string, look: Partial<RibbonLook> | undefined, W = 180, H = 220): Promise<string> {
  const job = shotQueue.then(async () => {
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(2);
    renderer.setSize(W, H);
    renderer.toneMapping = THREE.AgXToneMapping;
    try {
      const { scene, camera } = previewScene(renderer, W / H);
      const doll = new Ribbon3D(character);
      scene.add(doll.root);
      await doll.loaded;
      doll.setLook(look);
      doll.root.rotation.y = 0.35;
      doll.update(0.016);
      frameDoll(camera, doll);
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL("image/png");
    } finally {
      renderer.dispose();
      renderer.forceContextLoss();
    }
  });
  shotQueue = job.catch(() => undefined);
  return job;
}
