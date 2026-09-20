import * as THREE from "three";

/**
 * 작품마다 거는 **이미지 필터**와 **하이라이트** (2026-09-21, 핀 조명을 없애고 대신 넣었다).
 *
 *   - 필터: 밝기 · 대비 · 채도 · 색온도 · 세피아. 사진을 고치지 않고 값만 들고 있다가 그릴 때 입힌다.
 *     벽에 걸린 그림은 셰이더로(막대를 움직이는 대로 바로 바뀐다), 부모님 화면의 크게 보기·내려받기는 같은 식을 픽셀에 돌린다.
 *   - 하이라이트: 그 작품만 돋보이게 한다. 방 밝기를 낮춰도 그림은 제 밝기로 빛나고, 액자 둘레 벽에 은은한 빛이 번진다.
 * 그림면은 방 조명을 받지 않는 재질이다: 아이 그림의 색이 조명·톤매핑에 물들지 않고 올린 그대로 보인다.
 */
export interface ArtFx {
  /** 밝기 -1~1 */
  b: number;
  /** 대비 -1~1 */
  c: number;
  /** 채도 0(흑백)~2, 1 이 그대로 */
  s: number;
  /** 색온도 -1(차갑게)~1(따뜻하게) */
  w: number;
  /** 세피아 0~1 */
  sepia: number;
  /** 하이라이트 세기 0(끔)~2 */
  glow: number;
  /** 하이라이트 빛 색 0(따뜻한 전구색)~1(차가운 주광색) */
  glowTone: number;
  /** 하이라이트가 벽에 번지는 크기 0.4~2 */
  glowSize: number;
}

export const FX_NONE: ArtFx = { b: 0, c: 0, s: 1, w: 0, sepia: 0, glow: 0, glowTone: 0.35, glowSize: 1 };
export const FX_LIMIT: Record<keyof ArtFx, [number, number]> = {
  b: [-1, 1], c: [-1, 1], s: [0, 2], w: [-1, 1], sepia: [0, 1], glow: [0, 2], glowTone: [0, 1], glowSize: [0.4, 2],
};

/** 한 번에 고르는 필터 (막대 값을 채워 줄 뿐이고, 고른 뒤에 막대로 더 다듬는다) */
export const FX_PRESETS: { id: string; name: string; fx: Partial<ArtFx> }[] = [
  { id: "none", name: "원본", fx: { b: 0, c: 0, s: 1, w: 0, sepia: 0 } },
  { id: "vivid", name: "선명하게", fx: { b: 0.04, c: 0.22, s: 1.35, w: 0, sepia: 0 } },
  { id: "bright", name: "화사하게", fx: { b: 0.16, c: 0.06, s: 1.12, w: 0.1, sepia: 0 } },
  { id: "warm", name: "따뜻하게", fx: { b: 0.03, c: 0.05, s: 1.08, w: 0.45, sepia: 0 } },
  { id: "cool", name: "차갑게", fx: { b: 0.02, c: 0.05, s: 1.0, w: -0.45, sepia: 0 } },
  { id: "soft", name: "부드럽게", fx: { b: 0.1, c: -0.2, s: 0.85, w: 0.08, sepia: 0 } },
  { id: "mono", name: "흑백", fx: { b: 0, c: 0.12, s: 0, w: 0, sepia: 0 } },
  { id: "sepia", name: "세피아", fx: { b: 0.02, c: 0.05, s: 0.9, w: 0.1, sepia: 0.8 } },
  { id: "vintage", name: "빈티지", fx: { b: 0.05, c: -0.12, s: 0.7, w: 0.3, sepia: 0.35 } },
];

export function fxOf(raw: Partial<ArtFx> | null | undefined): ArtFx {
  const out = { ...FX_NONE };
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(FX_LIMIT) as (keyof ArtFx)[]) {
      const v = raw[k];
      if (typeof v === "number" && isFinite(v)) out[k] = Math.min(FX_LIMIT[k][1], Math.max(FX_LIMIT[k][0], v));
    }
  }
  return out;
}

/** 필터를 하나도 걸지 않았나 (하이라이트는 빼고) */
export const plainFx = (fx: ArtFx): boolean => !fx.b && !fx.c && fx.s === 1 && !fx.w && !fx.sepia;

/** 하이라이트 빛 색: 전구색 ~ 주광색 */
export function glowColor(tone: number): THREE.Color {
  return new THREE.Color(0xffc98a).lerp(new THREE.Color(0xe6f0ff), tone).lerp(new THREE.Color(0xfff4e2), 0.3);
}

// ---------- 같은 식을 셰이더와 픽셀 양쪽에 ----------
// 눈에 보이는 밝기(감마) 공간에서 셈한다: 밝기 -> 대비 -> 채도 -> 색온도 -> 세피아
const CONTRAST = (c: number): number => (c >= 0 ? 1 + c * 1.4 : 1 + c * 0.8);

/** 부모님 화면의 크게 보기·내려받기용: 캔버스의 픽셀에 필터를 입힌다 (셰이더와 같은 식) */
export function filterCanvas(src: HTMLCanvasElement, fx: ArtFx): HTMLCanvasElement {
  if (plainFx(fx)) return src;
  const ctx = src.getContext("2d")!;
  const img = ctx.getImageData(0, 0, src.width, src.height);
  const d = img.data, k = CONTRAST(fx.c);
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] / 255 + fx.b * 0.5, g = d[i + 1] / 255 + fx.b * 0.5, b = d[i + 2] / 255 + fx.b * 0.5;
    r = (r - 0.5) * k + 0.5; g = (g - 0.5) * k + 0.5; b = (b - 0.5) * k + 0.5;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    r = l + (r - l) * fx.s; g = l + (g - l) * fx.s; b = l + (b - l) * fx.s;
    r += fx.w * 0.12; g += fx.w * 0.02; b -= fx.w * 0.12;
    if (fx.sepia) {
      const sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b;
      r += (sr - r) * fx.sepia; g += (sg - g) * fx.sepia; b += (sb - b) * fx.sepia;
    }
    d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255;      // (Uint8ClampedArray 가 0~255 로 가둔다)
  }
  ctx.putImageData(img, 0, 0);
  return src;
}

/** 방 밝기 1 일 때 그림면의 밝기: 흰 종이가 렌더한 흰 벽보다 튀지 않게 조금 낮춘다 */
const PAPER = 0.88;

/** 벽에 거는 그림면의 재질 */
export function pictureMaterial(map: THREE.Texture, fx: ArtFx, room: number): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map }, bright: { value: 0 }, contrast: { value: 1 }, sat: { value: 1 }, warm: { value: 0 },
      sepia: { value: 0 }, level: { value: 1 },
    },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform sampler2D map; uniform float bright, contrast, sat, warm, sepia, level; varying vec2 vUv;
      void main() {
        vec3 c = pow(max(texture2D(map, vUv).rgb, 0.0), vec3(1.0 / 2.2));
        c += bright * 0.5;
        c = (c - 0.5) * contrast + 0.5;
        float l = dot(c, vec3(0.299, 0.587, 0.114));
        c = mix(vec3(l), c, sat);
        c += vec3(0.12, 0.02, -0.12) * warm;
        vec3 sp = vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131)));
        c = clamp(mix(c, sp, sepia), 0.0, 1.0);
        gl_FragColor = vec4(pow(c, vec3(2.2)) * level, 1.0);
        #include <colorspace_fragment>
      }`,
    toneMapped: false,
  });
  mat.userData.fx = fx;
  setPictureFx(mat, fx, room);
  return mat;
}

/** 필터 값·방 밝기를 재질에 넣는다 (막대를 움직이는 동안, 방 밝기를 바꿀 때) */
export function setPictureFx(mat: THREE.ShaderMaterial, fx: ArtFx, room: number): void {
  const u = mat.uniforms;
  mat.userData.fx = fx;
  u.bright.value = fx.b;
  u.contrast.value = CONTRAST(fx.c);
  u.sat.value = fx.s;
  u.warm.value = fx.w;
  u.sepia.value = fx.sepia;
  // 하이라이트를 켠 그림은 방이 어두워도 제 밝기로 (세게 주면 조금 더 밝게)
  const h = Math.min(1, fx.glow);
  u.level.value = PAPER * (room * (1 - h) + h) * (1 + 0.14 * fx.glow);
}

let haloTex: THREE.Texture | null = null;
function halo(): THREE.Texture {
  if (haloTex) return haloTex;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 256, 256);
  // 가운데 네모(액자 자리)에서 바깥으로 스러지는 빛: 네모를 여러 겹 번지게 겹쳐 그린다 (ctx.filter 는 사파리에 없다)
  for (let i = 0; i < 40; i++) {
    const t = i / 39, grow = (1 - t) * 78;
    ctx.fillStyle = `rgba(255,255,255,${0.035 + t * 0.03})`;
    const r = 64 - grow * 0.8;
    ctx.beginPath();
    ctx.roundRect(r, r, 256 - 2 * r, 256 - 2 * r, 10 + grow * 0.6);
    ctx.fill();
  }
  haloTex = new THREE.CanvasTexture(c);
  haloTex.colorSpace = THREE.SRGBColorSpace;
  return haloTex;
}

/**
 * 하이라이트의 벽 빛: 액자(outerW × outerH, 장면 단위) 둘레로 번지는 빛을 벽에 더하기로 얹는다. 꺼져 있으면 null.
 * 배경이 렌더한 사진이어도 보이도록 진짜 조명이 아니라 그려 넣는다
 */
export function buildGlow(outerW: number, outerH: number, fx: ArtFx, mm: (v: number) => number): THREE.Mesh | null {
  if (fx.glow <= 0) return null;
  // 빛 그림의 밝은 네모는 판의 가운데 절반이다: 판을 액자의 2배로 잡으면 밝은 곳이 액자에 가려지고 번지는 곳만 벽에 보인다
  const k = 1 + fx.glowSize;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(outerW * k, outerH * k),
    new THREE.MeshBasicMaterial({ map: halo(), color: glowColor(fx.glowTone).multiplyScalar(0.11 * fx.glow), transparent: true,
                                  blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
                                  polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: -3 }));
  mesh.name = "art-glow";
  mesh.position.z = mm(1);
  mesh.renderOrder = 2;
  return mesh;
}
