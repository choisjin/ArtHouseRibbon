import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { WORLD_BASE } from "./types";

/** 관리자 페이지에서 고르는 겉모습 (서버 settings_store.RibbonLook) */
export interface RibbonLook {
  outfit: string;              // 캐릭터마다 다르다 (CharacterSpec.outfits)
  hair: string;
  bow: string;
  dress: string;
  blouse: string;
}

export const DEFAULT_LOOK: RibbonLook = { outfit: "onepiece", hair: "#f48a9e", bow: "#de2834", dress: "#80d6be", blouse: "#ffe896" };

/**
 * 쓸 수 있는 캐릭터. 모두 Character_Creator 에서 같은 비율·같은 뼈대로 만들어서
 * 얼굴(Eye_L/R, Blush_L/R, Furrow_L/R, Mouth_*)과 동작(Walk/Greet/Nod/…/Peek)이 똑같다.
 * 다른 것은 모델 파일과 옷(부품 이름 앞머리), 색을 바꿀 수 있는 재질뿐이다.
 */
export interface CharacterSpec {
  id: string;
  name: string;
  file: string;                                   // world/ 아래 glb
  outfits: { id: string; name: string; prefix: string }[];
  tint: Record<string, keyof RibbonLook>;         // glb 재질 이름 → look 키 (없으면 색을 안 바꾼다)
}

export const CHARACTERS: Record<string, CharacterSpec> = {
  ribbon: {
    id: "ribbon", name: "리본이 (여자)", file: "doll.glb",
    outfits: [{ id: "onepiece", name: "원피스", prefix: "OP_" }, { id: "twopiece", name: "투피스", prefix: "TP_" }],
    tint: { Hair_Game: "hair", Bow_Game: "bow", Dress_Game: "dress", Blouse_Game: "blouse" },
  },
  ollie: {
    id: "ollie", name: "올리 (남자)", file: "ollie.glb",
    outfits: [{ id: "apron", name: "앞치마", prefix: "AP_" }, { id: "tee", name: "반팔 티", prefix: "TE_" }],
    // 올리는 색을 따로 고르지 않고 만들 때 정한 색(까만 머리·회색 티·청바지) 그대로 쓴다
    tint: {},
  },
  seoyul: {
    id: "seoyul", name: "서율 (여자)", file: "seoyul.glb",
    outfits: [{ id: "apron", name: "앞치마", prefix: "AP_" }, { id: "tee", name: "반팔 티", prefix: "TE_" }],
    // 서율이도 만들 때 정한 색(갈색 양갈래·흰 티·남색 바지·분홍 운동화) 그대로 쓴다
    tint: {},
  },
};

export const DEFAULT_CHARACTER = "ribbon";
export const characterOf = (id: string | undefined): CharacterSpec => CHARACTERS[id ?? ""] ?? CHARACTERS[DEFAULT_CHARACTER];

export interface DollAsset { scene: THREE.Group; animations: THREE.AnimationClip[] }

const cached = new Map<string, Promise<DollAsset>>();

/** 봉제 인형 천 재질: glb 의 단순 재질(기본색·거칠기)을 보풀 광택(sheen)이 있는 재질로 바꾼다 */
const GLOSSY = new Set(["Button_Game", "EyeFelt_Game"]);
/** 눈의 흰 광: 살짝 스스로 빛나서 어두운 곳에서도 눈이 초롱초롱 (Character_Creator doll.py M_EYE_HI 와 같게) */
const GLINT = "EyeHighlight_Game";
function fabric(src: THREE.Material): THREE.Material {
  const s = src as THREE.MeshStandardMaterial;
  if (!s.isMeshStandardMaterial) return src.clone();
  const m = new THREE.MeshPhysicalMaterial({
    name: s.name, color: s.color.clone(), map: s.map, transparent: s.transparent, opacity: s.opacity,
  });
  if (s.name === GLINT) {
    m.color.set(0xffffff);
    m.roughness = 0.3;
    m.clearcoat = 0.3;
    m.emissive = new THREE.Color(0xffffff);
    m.emissiveIntensity = 0.35;
  } else if (s.name === "EyeFelt_Game") {
    m.roughness = 0.55;                     // 광은 흰 조각이 맡으니 눈 자체는 덜 반짝이게
    m.clearcoat = 0.12;
  } else if (GLOSSY.has(s.name)) {
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

/** 캐릭터 glb 를 읽어 새 복제본을 준다 (재질은 복제본마다 따로 둬서 색을 바꿀 수 있게) */
export async function loadDoll(file = CHARACTERS[DEFAULT_CHARACTER].file): Promise<DollAsset> {
  let job = cached.get(file);
  if (!job) {
    job = new GLTFLoader().loadAsync(`${WORLD_BASE}${file}`).then((g) => ({ scene: g.scene, animations: g.animations }));
    cached.set(file, job);
  }
  const src = await job;
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

export function applyLook(root: THREE.Object3D, look: Partial<RibbonLook> | undefined,
                          spec: CharacterSpec = CHARACTERS[DEFAULT_CHARACTER]): void {
  const l = { ...DEFAULT_LOOK, ...(look ?? {}) };
  // 고른 옷만 보이게 (고른 옷이 이 캐릭터에 없으면 첫 번째 옷)
  const wear = spec.outfits.find((o) => o.id === l.outfit) ?? spec.outfits[0];
  const prefixes = spec.outfits.map((o) => o.prefix);
  root.traverse((o) => {
    if (prefixes.some((p) => o.name.startsWith(p))) o.visible = o.name.startsWith(wear.prefix);
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    const key = spec.tint[m.material.name];
    const mat = m.material as THREE.MeshPhysicalMaterial;
    if (key && mat.color) {
      mat.color.set(l[key] as string);
      mat.sheenColor?.set(0xffffff).lerp(mat.color, 0.35);
    }
  });
}
