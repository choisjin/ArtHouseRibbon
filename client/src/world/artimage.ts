/**
 * 작품 그림 합치기: 배경을 지운 작품(투명 PNG) 뒤에 **배경색**을 깔고 **여백**을 둔다.
 *
 * 올린 파일은 배경 없는 원본 그대로 두고(부모님이 그대로 내려받을 수 있게), 배경색·여백은 값으로만 들고 있다가
 * 보여 줄 때 합친다 — 벽에 거는 그림(world/room.ts), 편집 창 미리 보기(art/crop.ts), 부모님 전시실의 크게 보기·내려받기
 * (gallery/index.ts)가 모두 이 함수를 쓴다. 배경색을 정하지 않았으면 흰색이다 (투명한 곳이 검게 나오지 않게).
 */

/** 여백 [왼쪽, 위, 오른쪽, 아래]. 그림의 긴 변에 대한 비율 (0.1 = 긴 변의 10%) */
export type Pad = [number, number, number, number];

export const DEFAULT_BG = "#ffffff";
export const NO_PAD: Pad = [0, 0, 0, 0];
export const MAX_PAD = 0.4;

export interface ArtLook { bg?: string | null; pad?: number[] | null }

export function padOf(look: ArtLook | null | undefined): Pad {
  const p = look?.pad;
  if (!Array.isArray(p) || p.length !== 4) return NO_PAD;
  return p.map((v) => Math.min(MAX_PAD, Math.max(0, Number(v) || 0))) as Pad;
}

export const bgOf = (look: ArtLook | null | undefined): string =>
  /^#[0-9a-f]{6}$/i.test(look?.bg ?? "") ? look!.bg! : DEFAULT_BG;

/** 여백까지 넣은 크기 (원본 픽셀 기준) */
export function lookSize(w: number, h: number, look: ArtLook | null | undefined): { w: number; h: number } {
  const [l, t, r, b] = padOf(look);
  const side = Math.max(w, h);
  return { w: w + (l + r) * side, h: h + (t + b) * side };
}

/** 그림 뒤에 배경색을 깔고 여백을 둔 캔버스. maxSide 를 주면 그보다 크지 않게 줄인다 */
export function composeArt(img: CanvasImageSource, w: number, h: number, look: ArtLook | null | undefined,
                           maxSide = 0): HTMLCanvasElement {
  const [l, t] = padOf(look);
  const size = lookSize(w, h, look);
  const side = Math.max(w, h);
  const s = maxSide ? Math.min(1, maxSide / Math.max(size.w, size.h)) : 1;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(size.w * s));
  c.height = Math.max(1, Math.round(size.h * s));
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = bgOf(look);
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, l * side * s, t * side * s, w * s, h * s);
  return c;
}
