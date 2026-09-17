import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { WORLD_BASE } from "./types";

/** 관리자 페이지에서 고르는 리본이 겉모습 (서버 settings_store.RibbonLook) */
export interface RibbonLook {
  outfit: "onepiece" | "twopiece";
  hair: string;
  bow: string;
  dress: string;
  blouse: string;
}

export const DEFAULT_LOOK: RibbonLook = { outfit: "onepiece", hair: "#f48a9e", bow: "#de2834", dress: "#80d6be", blouse: "#ffe896" };

/** 옷은 부품 이름 앞머리로 나뉜다 (Character_Creator doll.py: OP_ 원피스, TP_ 투피스) */
const OUTFIT_PREFIX = { onepiece: "OP_", twopiece: "TP_" } as const;
/** 색을 바꾸는 재질 (glb 재질 이름 → look 키) */
const TINT: Record<string, keyof RibbonLook> = { Hair_Game: "hair", Bow_Game: "bow", Dress_Game: "dress", Blouse_Game: "blouse" };

export interface DollAsset { scene: THREE.Group; animations: THREE.AnimationClip[] }

let cached: Promise<DollAsset> | null = null;

/** 봉제 인형 천 재질: glb 의 단순 재질(기본색·거칠기)을 보풀 광택(sheen)이 있는 재질로 바꾼다 */
const GLOSSY = new Set(["Button_Game", "EyeFelt_Game"]);
function fabric(src: THREE.Material): THREE.Material {
  const s = src as THREE.MeshStandardMaterial;
  if (!s.isMeshStandardMaterial) return src.clone();
  const m = new THREE.MeshPhysicalMaterial({
    name: s.name, color: s.color.clone(), map: s.map, transparent: s.transparent, opacity: s.opacity,
  });
  if (GLOSSY.has(s.name)) {
    m.roughness = 0.35;
    m.clearcoat = 0.6;
  } else {
    m.roughness = Math.max(0.75, s.roughness);
    m.sheen = 1;
    m.sheenRoughness = 0.55;
    m.sheenColor = new THREE.Color(1, 1, 1).lerp(s.color, 0.35);
  }
  return m;
}

/** doll.glb 를 읽어 새 복제본을 준다 (재질은 복제본마다 따로 둬서 색을 바꿀 수 있게) */
export async function loadDoll(): Promise<DollAsset> {
  cached ??= new GLTFLoader().loadAsync(`${WORLD_BASE}doll.glb`).then((g) => ({ scene: g.scene, animations: g.animations }));
  const src = await cached;
  const scene = src.scene.clone(true);
  // 인형은 발밑 원점 기준이어야 한다. 내보낼 때 방 속 위치가 남아 있어도 수평 위치는 지운다
  for (const c of scene.children) c.position.set(0, c.position.y, 0);
  const mats = new Map<THREE.Material, THREE.Material>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    let c = mats.get(m.material);
    if (!c) { c = fabric(m.material); mats.set(m.material, c); }
    m.material = c;
  });
  return { scene, animations: src.animations };
}

export function applyLook(root: THREE.Object3D, look: Partial<RibbonLook> | undefined): void {
  const l = { ...DEFAULT_LOOK, ...(look ?? {}) };
  const hide = l.outfit === "twopiece" ? OUTFIT_PREFIX.onepiece : OUTFIT_PREFIX.twopiece;
  root.traverse((o) => {
    if (/^(OP|TP)_/.test(o.name)) o.visible = !o.name.startsWith(hide);
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    const key = TINT[m.material.name];
    const mat = m.material as THREE.MeshPhysicalMaterial;
    if (key && mat.color) {
      mat.color.set(l[key] as string);
      mat.sheenColor?.set(0xffffff).lerp(mat.color, 0.35);
    }
  });
}
