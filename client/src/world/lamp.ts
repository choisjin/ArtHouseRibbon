import * as THREE from "three";

/**
 * 작품마다 다는 핀 조명 (2026-09-21). 천장 레일 조명을 없애고, 그림 하나하나에 천장 핀 조명을 따로 단다.
 *
 * 방 배경은 블렌더로 구운 사진이라 three.js 의 빛으로는 벽이 밝아지지 않는다. 그래서 빛을 **그려 넣는다**:
 *   - 벽에 떨어지는 **빛 웅덩이**: 위가 밝고 아래로 길게 퍼지는 타원을 벽면에 더하기(additive)로 얹는다
 *   - **그림 자체**는 같은 색의 빛을 받은 만큼 스스로 밝아진다 (room.ts 가 emissive 로 넣는다)
 *   - 천장의 **조명 기구**(받침 + 목 + 원통 머리)는 그림 쪽을 보고, 켜져 있으면 렌즈가 빛난다
 * 진짜 SpotLight 를 그림 수만큼 두지 않으므로 폰에서도 가볍다.
 */
export interface ArtLamp {
  on: boolean;
  /** 조도 0~2 (1 = 보통) */
  power: number;
  /** 빛이 퍼지는 각도 (도). 작으면 그림만 또렷이, 크면 벽까지 넓게 */
  angle: number;
  /** 빛 색 0(따뜻한 전구색) ~ 1(차가운 주광색) */
  tone: number;
  /** 비추는 각도 (도, 수직에서 벽 쪽으로). 크면 조명이 벽에서 멀리 달려 빛이 덜 길쭉하다 */
  tilt: number;
}

export const LAMP_DEFAULT: ArtLamp = { on: true, power: 1, angle: 38, tone: 0.3, tilt: 30 };
export const LAMP_LIMIT = { power: [0, 2], angle: [16, 70], tone: [0, 1], tilt: [15, 50] } as const;

export function lampOf(raw: Partial<ArtLamp> | null | undefined): ArtLamp | null {
  if (!raw || typeof raw !== "object") return null;
  const num = (v: unknown, lo: number, hi: number, d: number): number =>
    (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    on: raw.on !== false,
    power: num(raw.power, 0, 2, LAMP_DEFAULT.power),
    angle: num(raw.angle, 16, 70, LAMP_DEFAULT.angle),
    tone: num(raw.tone, 0, 1, LAMP_DEFAULT.tone),
    tilt: num(raw.tilt, 15, 50, LAMP_DEFAULT.tilt),
  };
}

/** 빛 색: 전구색(2700K 쯤) ~ 주광색(6500K 쯤) */
export function lampColor(tone: number): THREE.Color {
  return new THREE.Color(0xffc37a).lerp(new THREE.Color(0xeaf2ff), tone).lerp(new THREE.Color(0xfff2dc), 0.25);
}

let poolTex: THREE.Texture | null = null;
/** 벽에 떨어진 빛: 가운데보다 조금 위가 가장 밝고, 아래로 길게 스러지는 타원 */
function pool(): THREE.Texture {
  if (poolTex) return poolTex;
  const N = 256;
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x / (N - 1)) * 2 - 1;
      let v = (y / (N - 1)) * 2 - 1;               // -1 위 ~ +1 아래
      v = v < -0.25 ? (v + 0.25) / 0.75 : (v + 0.25) / 1.25;   // 밝은 곳을 위로 올리고 아래를 길게
      const r = Math.hypot(u, v);
      const a = r >= 1 ? 0 : Math.pow(1 - r * r, 2.2);         // 가운데만 밝고 가장자리는 길게 스러진다
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(255 * a);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  poolTex = new THREE.CanvasTexture(c);
  poolTex.colorSpace = THREE.SRGBColorSpace;
  return poolTex;
}

const FIXTURE = new THREE.MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.45, metalness: 0.3 });

/**
 * 그림 가운데를 원점으로 (x 오른쪽, y 위, z 벽에서 방 안쪽) 핀 조명을 만든다. 단위는 장면 단위.
 * drop: 그림 가운데에서 천장까지의 높이. 천장이 없거나 너무 가까우면 null
 */
export function buildLamp(lamp: ArtLamp, drop: number, mm: (v: number) => number): THREE.Group | null {
  if (drop < mm(250)) return null;
  const g = new THREE.Group();
  g.name = "art-lamp";
  const tilt = THREE.MathUtils.degToRad(lamp.tilt);
  const away = Math.min(drop * Math.tan(tilt), mm(2600));      // 벽에서 떨어진 거리
  const head = new THREE.Vector3(0, drop - mm(190), away);     // 머리 자리 (천장에서 목 길이만큼 아래)
  const aim = head.clone().negate().normalize();               // 머리 -> 그림 가운데
  const color = lampColor(lamp.tone);

  // --- 기구: 천장 받침 - 목 - 머리 ---
  const base = new THREE.Mesh(new THREE.CylinderGeometry(mm(42), mm(42), mm(18), 20), FIXTURE);
  base.position.set(0, drop - mm(9), away);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(mm(7), mm(7), mm(150), 10), FIXTURE);
  stem.position.set(0, drop - mm(18 + 75), away);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(mm(38), mm(32), mm(130), 20), FIXTURE);
  body.position.copy(head);
  body.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), aim);   // 원통의 아래쪽 끝이 그림을 본다
  const lens = new THREE.Mesh(new THREE.CircleGeometry(mm(30), 20),
    new THREE.MeshBasicMaterial({ color: lamp.on ? color.clone().multiplyScalar(0.6 + 0.4 * Math.min(1, lamp.power)) : 0x111113,
                                  toneMapped: false }));
  lens.position.copy(head).addScaledVector(aim, mm(66));
  lens.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), aim);
  g.add(base, stem, body, lens);
  if (!lamp.on || lamp.power <= 0) return g;

  // --- 벽에 떨어진 빛 ---
  const reach = Math.hypot(drop, away);                         // 머리에서 그림까지
  const rx = reach * Math.tan(THREE.MathUtils.degToRad(lamp.angle) / 2) * 1.35;   // 번지는 가장자리까지 넉넉히
  const ry = rx / Math.max(0.35, Math.sin(tilt));               // 비스듬히 맞으므로 위아래로 길어진다
  const light = new THREE.Mesh(new THREE.PlaneGeometry(rx * 2, ry * 2),
    new THREE.MeshBasicMaterial({ map: pool(), color: color.clone().multiplyScalar(0.075 * lamp.power), transparent: true,
                                  blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
                                  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  light.position.set(0, -ry * 0.25, mm(1));                     // 가장 밝은 곳(판의 위쪽 1/4)이 그림 가운데에 오게 내린다
  light.renderOrder = 2;
  g.add(light);
  return g;
}
