import * as THREE from "three";

/**
 * 액자. 네모 막대 네 개를 붙이던 것을 실제 액자처럼 바꿨다 (2026-09-21):
 *   - **단면(profile)을 그림 둘레로 돌려** 만든다: 모서리는 45° 로 맞물리고, 안쪽 턱·경사·둥근 어깨가 빛을 받는다
 *   - 원목은 나뭇결, 금·은은 금속 질감
 *   - **매트**(그림과 액자 사이의 흰 종이 띠)를 두는 종류, 캔버스를 띄운 **플로팅 액자**
 *   - 벽에 떨어지는 **부드러운 그림자** (배경이 렌더 사진이어도 액자가 벽에 붙어 보이게)
 * 블렌더로 굽는 방(미술실·전시장)은 room_map.ART_FRAMES 의 네 가지(canvas/black/wood/white)만 알고, 나머지는 테두리 없이 굽는다.
 */

/** 단면의 한 점: [안쪽 끝에서 바깥으로(mm), 벽에서 앞으로(mm)] */
type Pt = [number, number];

export interface FrameStyle {
  id: string;
  name: string;
  /** 액자 폭 (mm). 0 이면 테두리 없음 */
  width: number;
  profile: Pt[];
  look: "paint" | "wood" | "metal";
  color: number;
  rough?: number;
  /** 매트(그림 둘레의 종이 띠) 폭 (mm) */
  mat?: number;
  matColor?: number;
  /** 플로팅: 그림과 액자 사이를 띄우는 틈 (mm) */
  gap?: number;
}

/** 평평한 단면에 모서리만 살짝 깎은 것 */
const flat = (w: number, d: number, lip = 6): Pt[] => [[0, d - lip], [2, d], [w - 2, d], [w, d - 3], [w, 0]];
/** 안쪽으로 경사진 단면 (그림 쪽이 낮다) */
const slope = (w: number, d: number): Pt[] => [[0, d * 0.45], [3, d * 0.55], [w * 0.7, d], [w - 3, d], [w, d - 4], [w, 0]];
/** 둥근 어깨 */
const round = (w: number, d: number): Pt[] => {
  const pts: Pt[] = [[0, d * 0.5]];
  for (let i = 0; i <= 8; i++) {
    const t = (i / 8) * Math.PI;
    pts.push([w / 2 - Math.cos(t) * w / 2, d * 0.5 + Math.sin(t) * d * 0.5]);
  }
  pts.push([w, 0]);
  return pts;
};
/** 앤틱: 안쪽 턱 - 오목한 골 - 볼록한 테 - 바깥 턱 */
const antique = (w: number, d: number): Pt[] => {
  const pts: Pt[] = [[0, d * 0.35], [w * 0.06, d * 0.5], [w * 0.12, d * 0.5]];
  for (let i = 0; i <= 6; i++) {                 // 오목한 골
    const t = i / 6;
    pts.push([w * (0.12 + 0.33 * t), d * (0.5 - 0.18 * Math.sin(t * Math.PI))]);
  }
  for (let i = 0; i <= 8; i++) {                 // 볼록한 테
    const t = (i / 8) * Math.PI;
    pts.push([w * (0.45 + 0.4 * (1 - Math.cos(t)) / 2), d * (0.5 + 0.5 * Math.sin(t))]);
  }
  pts.push([w * 0.92, d * 0.42], [w, d * 0.36], [w, 0]);
  return pts;
};

export const FRAME_STYLES: FrameStyle[] = [
  { id: "canvas", name: "캔버스 (테두리 없음)", width: 0, profile: [], look: "paint", color: 0xf4f1ea },
  { id: "white", name: "흰 액자", width: 30, profile: flat(30, 38), look: "paint", color: 0xf6f5f1, rough: 0.45 },
  { id: "black", name: "검은 액자", width: 20, profile: flat(20, 38), look: "paint", color: 0x1d1d1f, rough: 0.4 },
  { id: "wood", name: "원목 (오크)", width: 40, profile: round(40, 42), look: "wood", color: 0xb98a5a, rough: 0.55 },
  { id: "walnut", name: "원목 (월넛)", width: 48, profile: slope(48, 44), look: "wood", color: 0x5b3b26, rough: 0.5 },
  { id: "gold", name: "앤틱 골드", width: 70, profile: antique(70, 52), look: "metal", color: 0xc9a24a, rough: 0.38 },
  { id: "silver", name: "슬림 실버", width: 12, profile: flat(12, 30, 3), look: "metal", color: 0xc9ccd1, rough: 0.3 },
  { id: "brass", name: "슬림 골드", width: 12, profile: flat(12, 30, 3), look: "metal", color: 0xcaa45a, rough: 0.3 },
  { id: "white_mat", name: "흰 액자 + 매트", width: 25, profile: flat(25, 36), look: "paint", color: 0xf6f5f1, rough: 0.45, mat: 70 },
  { id: "black_mat", name: "검은 액자 + 매트", width: 18, profile: flat(18, 36), look: "paint", color: 0x1d1d1f, rough: 0.4, mat: 70 },
  { id: "wood_mat", name: "원목 + 매트", width: 32, profile: round(32, 40), look: "wood", color: 0xb98a5a, rough: 0.55, mat: 80 },
  { id: "gold_mat", name: "앤틱 골드 + 매트", width: 55, profile: antique(55, 46), look: "metal", color: 0xc9a24a, rough: 0.38, mat: 60, matColor: 0xf3ecdc },
  { id: "float", name: "플로팅 (검정)", width: 14, profile: flat(14, 48, 0), look: "paint", color: 0x161617, rough: 0.45, gap: 10 },
  { id: "float_wood", name: "플로팅 (원목)", width: 14, profile: flat(14, 48, 0), look: "wood", color: 0xc79a68, rough: 0.55, gap: 10 },
];

const BY_ID = new Map(FRAME_STYLES.map((f) => [f.id, f]));
export const frameStyle = (id: string | null | undefined): FrameStyle => BY_ID.get(id ?? "canvas") ?? FRAME_STYLES[0];

/** 그림 둘레로 더 나가는 폭 (mm): 매트 + 틈 + 액자. 받침대(이젤)에 올릴 때 바닥에서 띄우는 높이로도 쓴다 */
export const frameReach = (f: FrameStyle): number => (f.mat ?? 0) + (f.gap ?? 0) + f.width;

// ---------- 재질 ----------
let grain: THREE.Texture | null = null;
/** 나뭇결: 결 방향으로 길게 늘어진 줄무늬 + 잔 잡음 (흑백이라 액자 색에 곱해 쓴다) */
function woodGrain(): THREE.Texture {
  if (grain) return grain;
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#d8d8d8";
  ctx.fillRect(0, 0, c.width, c.height);
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 90; i++) {
    const y = rnd() * c.height;
    ctx.strokeStyle = `rgba(${rnd() < 0.5 ? "60,40,20" : "255,245,230"},${0.06 + rnd() * 0.16})`;
    ctx.lineWidth = 0.6 + rnd() * 2.2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= c.width; x += 32) ctx.lineTo(x, y + Math.sin(x / 70 + i) * 2.5 + (rnd() - 0.5) * 1.5);
    ctx.stroke();
  }
  grain = new THREE.CanvasTexture(c);
  grain.colorSpace = THREE.SRGBColorSpace;
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  grain.anisotropy = 8;
  return grain;
}

function frameMaterial(f: FrameStyle): THREE.MeshStandardMaterial {
  if (f.look === "wood") return new THREE.MeshStandardMaterial({ color: f.color, map: woodGrain(), roughness: f.rough ?? 0.55 });
  if (f.look === "metal") return new THREE.MeshStandardMaterial({ color: f.color, roughness: f.rough ?? 0.35, metalness: 0.85 });
  return new THREE.MeshStandardMaterial({ color: f.color, roughness: f.rough ?? 0.45 });
}

/**
 * 단면을 네모(안쪽 가로 w × 세로 h) 둘레로 돌린 액자. 단위는 장면 단위이고 mm 는 장면 단위로 바꾸는 함수.
 * 모서리는 45° 로 맞물린다. 면마다 꼭짓점을 따로 두어 각진 곳은 각지게, uv 는 결이 막대 길이를 따라가게 준다
 */
export function frameGeometry(w: number, h: number, profile: Pt[], mm: (v: number) => number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [];
  const ring = (d: number): [number, number][] => [[-w / 2 - d, -h / 2 - d], [w / 2 + d, -h / 2 - d], [w / 2 + d, h / 2 + d], [-w / 2 - d, h / 2 + d]];
  let across = 0;
  for (let k = 0; k + 1 < profile.length; k++) {
    const [d0, z0] = [mm(profile[k][0]), mm(profile[k][1])], [d1, z1] = [mm(profile[k + 1][0]), mm(profile[k + 1][1])];
    const a = ring(d0), b = ring(d1);
    const step = Math.hypot(d1 - d0, z1 - z0);
    for (let s = 0; s < 4; s++) {
      const n = (s + 1) % 4;
      const len = Math.hypot(a[n][0] - a[s][0], a[n][1] - a[s][1]);
      // 네모 한 변의 띠: 안쪽 두 점(a) - 바깥 두 점(b)
      const quad = [[a[s][0], a[s][1], z0, 0, across], [a[n][0], a[n][1], z0, len, across],
        [b[n][0], b[n][1], z1, len, across + step], [b[s][0], b[s][1], z1, 0, across + step]];
      for (const i of [0, 2, 1, 0, 3, 2]) {      // 둘레를 시계 반대로 돌므로 이 차례라야 면이 앞(방 안쪽)을 본다
        pos.push(quad[i][0], quad[i][1], quad[i][2]);
        uv.push(quad[i][3] / mm(400), quad[i][4] / mm(60));
      }
    }
    across += step;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

let shadowTex: THREE.Texture | null = null;
/** 벽에 떨어지는 그림자: 가장자리가 번진 어두운 네모 */
function wallShadow(): THREE.Texture {
  if (shadowTex) return shadowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.filter = "blur(18px)";
  ctx.fillStyle = "#000";
  ctx.fillRect(48, 48, 160, 160);
  shadowTex = new THREE.CanvasTexture(c);
  return shadowTex;
}

export interface FrameParts {
  /** 그림면이 놓일 깊이 (장면 단위, 벽에서 앞으로) */
  pictureZ: number;
  meshes: THREE.Object3D[];
  /** 벽에 떨어지는 그림자 (그림 크기를 잴 때는 빼야 해서 따로 준다) */
  shade: THREE.Object3D;
}

/** 그림(w × h, 장면 단위) 둘레의 액자·매트·뒤판·그림자를 만든다 */
export function buildFrame(w: number, h: number, f: FrameStyle, mm: (v: number) => number): FrameParts {
  const meshes: THREE.Object3D[] = [];
  const mat = mm(f.mat ?? 0), gap = mm(f.gap ?? 0);
  const innerW = w + 2 * (mat + gap), innerH = h + 2 * (mat + gap);
  const outerW = innerW + 2 * mm(f.width), outerH = innerH + 2 * mm(f.width);
  const depth = f.width ? mm(Math.max(...f.profile.map((p) => p[1]))) : mm(30);
  // 그림면 깊이: 액자가 있으면 안쪽 턱 아래, 플로팅은 조금 더 안쪽, 캔버스는 틀 두께 앞
  const pictureZ = !f.width ? mm(30) : f.gap ? depth - mm(12) : mm(f.profile[0][1]) - mm(3);

  // 뒤판 / 캔버스 옆면
  const back = new THREE.Mesh(new THREE.BoxGeometry(f.gap ? w : innerW, f.gap ? h : innerH, pictureZ),
    new THREE.MeshStandardMaterial({ color: f.width && !f.gap ? 0x2a2725 : 0xf1ede4, roughness: 0.85 }));
  back.position.z = pictureZ / 2;
  meshes.push(back);
  if (f.gap) {                                   // 플로팅: 틈 사이로 보이는 어두운 바닥판
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(innerW, innerH), new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.9 }));
    floor.position.z = mm(4);
    meshes.push(floor);
  }
  if (mat) {
    const board = new THREE.Mesh(new THREE.PlaneGeometry(innerW, innerH),
      new THREE.MeshStandardMaterial({ color: f.matColor ?? 0xfbfaf6, roughness: 0.95 }));
    board.position.z = pictureZ + mm(0.4);
    meshes.push(board);
    // 매트를 비스듬히 따낸 안쪽 단면 (흰 속살이 가는 줄로 보인다)
    const bevel = new THREE.Mesh(frameGeometry(w, h, [[0, 0], [2.4, 1.8]], mm),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide }));
    bevel.position.z = pictureZ + mm(1);
    meshes.push(bevel);
  }
  if (f.width) {
    const bars = new THREE.Mesh(frameGeometry(innerW, innerH, f.profile, mm), frameMaterial(f));
    meshes.push(bars);
  }
  // 그림자: 아래로 조금 처지고 액자보다 넉넉하게 번진다
  // (그림자 그림은 가운데 62.5% 가 진한 네모라, 판을 1.6배로 잡으면 진한 곳이 액자 크기와 맞는다)
  const drop = mm(14) + depth * 0.6;
  const shade = new THREE.Mesh(new THREE.PlaneGeometry(outerW * 1.6 + drop, outerH * 1.6 + drop),
    new THREE.MeshBasicMaterial({ map: wallShadow(), transparent: true, opacity: 0.36, depthWrite: false, toneMapped: false,
                                  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  shade.position.set(0, -drop * 0.55, mm(2));
  shade.renderOrder = 1;
  return { pictureZ, meshes, shade };
}
