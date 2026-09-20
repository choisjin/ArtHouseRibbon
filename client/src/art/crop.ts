/**
 * 작품 사진 다듬기 (전시실 꾸미기의 '사진 올리기'와 '배경 지우기').
 *
 * 가장자리 색으로 지우던 방식은 책상 무늬·그림자·흰 종이에 약했다 (2026-09-21 "품질이 너무 안좋아"). 그래서
 *   - **AI 가 작품을 골라낸다**: 서버(ribbon/cutout.py, BiRefNet)가 마스크를 주고, 여기서 원본 크기로 잘라 낸다.
 *   - **네모로 펴기**: 종이에 그린 그림은 네 귀퉁이를 맞추면 비스듬히 찍힌 것도 반듯한 네모로 편다.
 *     귀퉁이는 AI 마스크에서 먼저 짐작해 놓고, 손으로 끌어 고친다.
 *   - **모양대로**: 만들기 작품처럼 네모가 아닌 것은 마스크 모양 그대로 투명하게 오려 낸다.
 * 서버에 모델이 없으면(onnxruntime·pillow 없음) 예전처럼 색으로 지운다 ('지우는 정도' 막대가 나온다).
 */

export interface Artwork { file: string; name: string; width: number; height: number; kid_id?: string | null }
export interface Cropper { edit(a: Artwork): Promise<void> }

type Mode = "quad" | "shape" | "none";
type P = { x: number; y: number };

const MAX_SIDE = 2000;          // 올리기 전에 이 크기로 줄인다 (부모님이 크게 볼 수 있을 만큼은 남긴다)
const AI_SIDE = 1024;           // AI 에 보내는 크기 (모델 입력이 1024 라 더 커도 소용없다)

async function post<T>(url: string, body: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({})) as T;
  return { status: res.status, data };
}

export function mountCrop(kidId: () => string, done: (a: Artwork, replaced?: Artwork) => Promise<void>,
                          msg: (t: string, e?: boolean) => void): Cropper {
  const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
  const file = $<HTMLInputElement>("#file");
  const dlg = $<HTMLDivElement>("#crop");
  const canvas = $<HTMLCanvasElement>("#cv");
  const wrap = $<HTMLDivElement>("#cv-wrap");
  const status = $("#crop-status");
  const tolRow = $("#tol-row");
  const tol = $<HTMLInputElement>("#tol");
  const handles = [...wrap.querySelectorAll<HTMLElement>(".corner")];

  let src: ImageData | null = null;        // 줄인 원본
  let srcCanvas: HTMLCanvasElement | null = null;
  let alpha: Uint8ClampedArray | null = null;   // 작품이면 255 (원본 크기)
  let quad: P[] = [];                      // 네 귀퉁이 (원본 픽셀, 왼위·오위·오아래·왼아래)
  let mode: Mode = "quad";
  let picked = false;                      // 방식을 손으로 골랐나 (고르기 전에는 AI 결과를 보고 알아서 정한다)
  let useColor = false;                    // AI 를 못 써서 색으로 지우는 중
  let ready = false;                       // 마스크가 왔나
  let replacing: Artwork | null = null;
  let session = 0;                         // 창을 닫았다 다시 열면 늦게 온 AI 답은 버린다

  const open = (img: HTMLImageElement, name: string, replaced: Artwork | null): void => {
    srcCanvas = shrink(img, MAX_SIDE);
    src = srcCanvas.getContext("2d")!.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    alpha = null;
    ready = false;
    useColor = false;
    picked = false;
    mode = "quad";
    replacing = replaced;
    const { width: w, height: h } = src;
    quad = [{ x: w * 0.06, y: h * 0.06 }, { x: w * 0.94, y: h * 0.06 }, { x: w * 0.94, y: h * 0.94 }, { x: w * 0.06, y: h * 0.94 }];
    $("#crop-name").textContent = name;
    $("#crop-ok").textContent = replaced ? "바꾸기" : "올리기";
    tolRow.hidden = true;
    dlg.classList.add("open");
    draw();
    void askAi(++session);
  };

  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    try { open(await readImage(f), f.name, null); } catch (e) { msg(String(e), true); }
  };

  /** 서버에 마스크를 부탁한다. 모델을 받는 중이면 기다렸다 다시 묻고, 못 쓰면 색으로 지운다 */
  async function askAi(my: number): Promise<void> {
    if (!srcCanvas || !src) return;
    status.textContent = "AI 가 작품을 찾는 중…";
    const small = shrinkCanvas(srcCanvas, AI_SIDE);
    const data = small.toDataURL("image/jpeg", 0.9);
    for (let tries = 0; tries < 200; tries++) {
      let r: { status: number; data: { mask?: string; state?: string; progress?: number; detail?: string } };
      try { r = await post("/api/cutout", { data }); } catch { r = { status: 0, data: {} }; }
      if (my !== session || !src) return;
      if (r.status === 200 && r.data.mask) {
        const m = await maskToAlpha(r.data.mask, src.width, src.height);
        if (my !== session || !src) return;
        alpha = keepBig(m, src.width, src.height);
        fromMask();
        return;
      }
      if (r.status === 202) {
        status.textContent = `AI 모델을 받는 중… ${Math.round((r.data.progress ?? 0) * 100)}% (처음 한 번만)`;
        await new Promise((ok) => setTimeout(ok, 3000));
        continue;
      }
      break;
    }
    if (my !== session || !src) return;
    // AI 를 못 쓴다: 예전 방식 (가장자리 색과 비슷한 곳을 지운다)
    useColor = true;
    tolRow.hidden = false;
    alpha = colorMask(src, Number(tol.value));
    fromMask("AI 를 쓸 수 없어 색으로 지웁니다. '지우는 정도'를 맞춰 보세요.");
  }

  /** 마스크가 생겼다: 귀퉁이를 짐작하고, 아직 고르지 않았으면 네모인지 보고 방식을 정한다 */
  function fromMask(note = ""): void {
    if (!src || !alpha) return;
    const found = cornersOf(alpha, src.width, src.height);
    if (found) {
      quad = found.quad;
      if (!picked) mode = found.fill > 0.86 ? "quad" : "shape";
    }
    ready = true;
    hint(note);
    draw();
  }

  function hint(note = ""): void {
    if (!ready) return;                       // 아직 AI 를 기다리는 중이면 그 안내를 둔다
    status.textContent = note || (mode === "quad" ? "네 귀퉁이가 맞는지 보고, 어긋났으면 점을 끌어 맞추세요."
      : mode === "shape" ? "작품 모양대로 오렸습니다. 종이에 그린 그림이면 '네모로 펴기'가 더 깔끔해요."
      : "사진을 그대로 올립니다.");
  }

  // ---------- 미리 보기 ----------
  function draw(): void {
    if (!src || !srcCanvas) return;
    dlg.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    const shown = mode === "shape" && alpha ? cutOut(src, alpha) : srcCanvas;
    const maxW = (wrap.parentElement?.clientWidth || 480) - 2, maxH = window.innerHeight * 0.5;   // 창 안쪽 너비에 맞춘다 (점 자리가 어긋나지 않게)
    const s = Math.min(1, maxW / shown.width, maxH / shown.height);
    canvas.width = Math.max(1, Math.round(shown.width * s));
    canvas.height = Math.max(1, Math.round(shown.height * s));
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(shown, 0, 0, canvas.width, canvas.height);
    const onQuad = mode === "quad";
    handles.forEach((h) => { h.hidden = !onQuad; });
    if (onQuad) {
      // 네모 밖은 어둡게, 테두리는 분홍으로
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      quad.forEach((p, i) => (i ? ctx.lineTo(p.x * s, p.y * s) : ctx.moveTo(p.x * s, p.y * s)));
      ctx.closePath();
      ctx.fillStyle = "rgba(20,16,28,.55)";
      ctx.fill("evenodd");
      ctx.beginPath();
      quad.forEach((p, i) => (i ? ctx.lineTo(p.x * s, p.y * s) : ctx.moveTo(p.x * s, p.y * s)));
      ctx.closePath();
      ctx.strokeStyle = "#e9557d";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      quad.forEach((p, i) => {
        handles[i].style.left = `${p.x * s}px`;
        handles[i].style.top = `${p.y * s}px`;
      });
    }
    const out = mode === "quad" ? quadSize(quad) : { w: shown.width, h: shown.height };
    $("#crop-size").textContent = `${Math.round(out.w)}×${Math.round(out.h)}`;
  }

  handles.forEach((h, i) => {
    h.onpointerdown = (ev) => {
      ev.preventDefault();
      h.setPointerCapture(ev.pointerId);
      h.onpointermove = (e) => {
        if (!src) return;
        const r = canvas.getBoundingClientRect();
        quad[i] = {
          x: clamp((e.clientX - r.left) / r.width, 0, 1) * src.width,
          y: clamp((e.clientY - r.top) / r.height, 0, 1) * src.height,
        };
        draw();
      };
      h.onpointerup = h.onpointercancel = () => { h.onpointermove = null; };
    };
  });
  dlg.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => {
    b.onclick = () => { mode = b.dataset.mode as Mode; picked = true; hint(); draw(); };
  });
  tol.oninput = () => {
    if (!useColor || !src) return;
    alpha = colorMask(src, Number(tol.value));
    draw();
  };
  window.addEventListener("resize", () => { if (dlg.classList.contains("open")) draw(); });

  const close = (): void => { dlg.classList.remove("open"); src = null; srcCanvas = null; alpha = null; replacing = null; session++; };
  $("#crop-cancel").onclick = close;
  $("#crop-ok").onclick = async () => {
    if (!src || !srcCanvas) return;
    const out = mode === "quad" ? warp(src, quad) : mode === "shape" && alpha ? cutOut(src, alpha) : srcCanvas;
    const name = ($("#crop-name").textContent || "작품").replace(/\.[^.]+$/, "");
    // 투명한 곳이 있는 것만 PNG (네모난 사진은 JPEG 가 훨씬 가볍다)
    const data = mode === "shape" ? out.toDataURL("image/png") : out.toDataURL("image/jpeg", 0.92);
    const replaced = replacing;
    const ok = $<HTMLButtonElement>("#crop-ok");
    ok.disabled = true;
    try {
      const r = await post<{ artwork?: Artwork; detail?: string }>("/api/artworks",
        { name, data, width: out.width, height: out.height, kid_id: kidId() });
      if (r.status !== 200 || !r.data.artwork) throw new Error(r.data.detail || `올리지 못했습니다 (${r.status})`);
      close();
      await done(r.data.artwork, replaced ?? undefined);
    } catch (e) { msg(String(e), true); } finally { ok.disabled = false; }
  };

  return {
    async edit(a: Artwork): Promise<void> {
      try { open(await loadImage(`/${a.file}`), a.name, a); } catch (e) { msg(String(e), true); }
    },
  };
}

// =====================================================================
// 그림 다루기
// =====================================================================
function readImage(f: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(f);
  return loadImage(url).finally(() => URL.revokeObjectURL(url));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, no) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => no(new Error("사진을 읽지 못했습니다"));
    img.src = url;
  });
}

function shrink(img: HTMLImageElement, max: number): HTMLCanvasElement {
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * s));
  c.height = Math.max(1, Math.round(img.naturalHeight * s));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function shrinkCanvas(src: HTMLCanvasElement, max: number): HTMLCanvasElement {
  const s = Math.min(1, max / Math.max(src.width, src.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(src.width * s));
  c.height = Math.max(1, Math.round(src.height * s));
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";                     // 이미 투명한 사진을 다시 다듬을 때 (JPEG 는 투명이 검게 된다)
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** 서버가 준 흑백 마스크(작게 온다)를 원본 크기의 알파 값으로 */
async function maskToAlpha(url: string, w: number, h: number): Promise<Uint8ClampedArray> {
  const img = await loadImage(url);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4];
  return out;
}

/** 가장 큰 덩어리(와 그에 견줄 만한 덩어리)만 남긴다: 옆에 같이 찍힌 연필·지우개 따위를 뺀다 */
function keepBig(alpha: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const label = new Int32Array(w * h);
  const sizes: number[] = [0];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < alpha.length; start++) {
    if (alpha[start] < 32 || label[start]) continue;
    const id = sizes.length;
    let top = 0, n = 0;
    stack[top++] = start;
    label[start] = id;
    while (top) {
      const i = stack[--top];
      n++;
      const x = i % w;
      if (x > 0 && !label[i - 1] && alpha[i - 1] >= 32) { label[i - 1] = id; stack[top++] = i - 1; }
      if (x < w - 1 && !label[i + 1] && alpha[i + 1] >= 32) { label[i + 1] = id; stack[top++] = i + 1; }
      if (i >= w && !label[i - w] && alpha[i - w] >= 32) { label[i - w] = id; stack[top++] = i - w; }
      if (i < alpha.length - w && !label[i + w] && alpha[i + w] >= 32) { label[i + w] = id; stack[top++] = i + w; }
    }
    sizes.push(n);
  }
  const biggest = Math.max(...sizes);
  if (!biggest) return alpha;
  const out = new Uint8ClampedArray(alpha.length);
  for (let i = 0; i < out.length; i++) if (label[i] && sizes[label[i]] >= biggest * 0.15) out[i] = alpha[i];
  return out;
}

/** 마스크에서 네 귀퉁이를 짐작한다 (대각선 방향으로 가장 끝에 있는 점). fill 은 그 네모를 작품이 얼마나 채우는가 */
function cornersOf(alpha: Uint8ClampedArray, w: number, h: number): { quad: P[]; fill: number } | null {
  let tl = -1, tr = -1, br = -1, bl = -1, area = 0;
  let sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] < 128) continue;
    area++;
    const x = i % w, y = (i - x) / w;
    const s = x + y, d = x - y;
    if (s < sMin) { sMin = s; tl = i; }
    if (s > sMax) { sMax = s; br = i; }
    if (d > dMax) { dMax = d; tr = i; }
    if (d < dMin) { dMin = d; bl = i; }
  }
  if (area < w * h * 0.01) return null;
  const pt = (i: number): P => ({ x: i % w, y: Math.floor(i / w) });
  const quad = [pt(tl), pt(tr), pt(br), pt(bl)];
  // 가장자리에 책상 색이 묻어나지 않게 가운데 쪽으로 아주 조금 당긴다
  const cx = quad.reduce((a, p) => a + p.x, 0) / 4, cy = quad.reduce((a, p) => a + p.y, 0) / 4;
  const inset = quad.map((p) => ({ x: p.x + (cx - p.x) * 0.006, y: p.y + (cy - p.y) * 0.006 }));
  let twice = 0;                                // 신발끈 공식
  quad.forEach((p, i) => { const q = quad[(i + 1) % 4]; twice += p.x * q.y - q.x * p.y; });
  const quadArea = Math.abs(twice) / 2;
  return { quad: inset, fill: quadArea ? area / quadArea : 0 };
}

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
function quadSize(q: P[]): { w: number; h: number } {
  return { w: Math.max(dist(q[0], q[1]), dist(q[3], q[2])), h: Math.max(dist(q[0], q[3]), dist(q[1], q[2])) };
}

/** 네 귀퉁이 안쪽을 반듯한 네모로 편다 (원근 변환 + 두 방향 보간) */
function warp(src: ImageData, quad: P[]): HTMLCanvasElement {
  const size = quadSize(quad);
  const W = Math.max(8, Math.round(size.w)), H = Math.max(8, Math.round(size.h));
  const m = homography([{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], quad);
  const out = new ImageData(W, H);
  const s = src.data, d = out.data, sw = src.width, sh = src.height;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5, py = y + 0.5;
      const k = m[6] * px + m[7] * py + 1;
      const u = clamp((m[0] * px + m[1] * py + m[2]) / k - 0.5, 0, sw - 1.001);
      const v = clamp((m[3] * px + m[4] * py + m[5]) / k - 0.5, 0, sh - 1.001);
      const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
      const a = (y0 * sw + x0) * 4, b = a + 4, c = a + sw * 4, e = c + 4;
      const o = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        d[o + ch] = (s[a + ch] * (1 - fx) + s[b + ch] * fx) * (1 - fy) + (s[c + ch] * (1 - fx) + s[e + ch] * fx) * fy;
      }
      d[o + 3] = 255;
    }
  }
  return toCanvas(out);
}

/** from 네 점을 to 네 점으로 보내는 원근 변환 (8 미지수 연립방정식) */
function homography(from: P[], to: P[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i], { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {                 // 가우스 소거
    let best = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[best][c])) best = r;
    [A[c], A[best]] = [A[best], A[c]];
    const p = A[c][c] || 1e-12;
    for (let k = c; k < 9; k++) A[c][k] /= p;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f) for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row) => row[8]);
}

/** 마스크대로 투명하게 만들고 남은 곳에 딱 맞게 자른다 */
function cutOut(src: ImageData, alpha: Uint8ClampedArray): HTMLCanvasElement {
  const { width: w, height: h } = src;
  const out = new Uint8ClampedArray(src.data);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < alpha.length; i++) {
    const a = Math.min(alpha[i], src.data[i * 4 + 3]);
    out[i * 4 + 3] = a;
    if (a < 24) continue;
    const x = i % w, y = (i - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < x0 || y1 < y0) return toCanvas(src);  // 다 지워졌으면 그대로
  const full = toCanvas(new ImageData(out, w, h));
  const c = document.createElement("canvas");
  c.width = x1 - x0 + 1;
  c.height = y1 - y0 + 1;
  c.getContext("2d")!.drawImage(full, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

function toCanvas(d: ImageData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = d.width;
  c.height = d.height;
  c.getContext("2d")!.putImageData(d, 0, 0);
  return c;
}

/**
 * (AI 를 못 쓸 때) 색으로 지우기: 사진 가장자리에서 시작해 비슷한 색으로 이어진 곳을 지운다.
 * tol 은 0~100, 클수록 많이 지운다. 작품인 곳이 255 인 마스크를 준다
 */
function colorMask(src: ImageData, tol: number): Uint8ClampedArray {
  const { width: w, height: h } = src;
  const px = src.data;
  const limit = (tol / 100) * 160 * 3;          // 색 거리 한계
  const cut = new Uint8Array(w * h);
  const work: number[] = [];
  const edge: number[] = [];
  for (let x = 0; x < w; x++) edge.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) edge.push(y * w, y * w + w - 1);
  let br = 0, bg = 0, bb = 0;                   // 가장자리 색들의 평균을 배경색으로 본다
  for (const i of edge) { br += px[i * 4]; bg += px[i * 4 + 1]; bb += px[i * 4 + 2]; }
  br /= edge.length; bg /= edge.length; bb /= edge.length;
  const near = (i: number) =>
    Math.abs(px[i * 4] - br) + Math.abs(px[i * 4 + 1] - bg) + Math.abs(px[i * 4 + 2] - bb) <= limit;
  for (const i of edge) if (!cut[i] && near(i)) { cut[i] = 1; work.push(i); }
  let head = 0;
  while (head < work.length) {
    const i = work[head++];
    const x = i % w, y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j < 0 || cut[j] || !near(j)) continue;
      cut[j] = 1;
      work.push(j);
    }
  }
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < out.length; i++) out[i] = cut[i] ? 0 : 255;
  return out;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** 전시실 꾸미기 화면에 넣는 다듬기 창 (art/index.ts 의 PAGE 에 들어간다) */
export const CROP_HTML = `
<div id="crop" class="modal">
  <div class="box">
    <b id="crop-name"></b>
    <div class="row wrap">
      <button data-mode="quad">▭ 네모로 펴기</button>
      <button data-mode="shape">✂ 모양대로 오리기</button>
      <button data-mode="none">원본 그대로</button>
    </div>
    <div id="cv-wrap"><canvas id="cv"></canvas>
      <i class="corner" hidden></i><i class="corner" hidden></i><i class="corner" hidden></i><i class="corner" hidden></i>
    </div>
    <p class="hint" id="crop-status"></p>
    <label class="row" id="tol-row" hidden>지우는 정도 <input id="tol" type="range" min="2" max="60" value="16" style="flex:1"></label>
    <div class="row"><span class="hint" id="crop-size"></span>
      <span class="grow"></span>
      <button id="crop-cancel" class="ghost">취소</button>
      <button id="crop-ok" class="on">올리기</button></div>
  </div>
</div>`;

export const CROP_CSS = `
  #crop { z-index:6 }
  #crop .box { width:min(640px,94vw) }
  #cv-wrap { position:relative; align-self:center; line-height:0; touch-action:none }
  #cv { max-width:100%; background:conic-gradient(#eee 25%, #fff 0 50%, #eee 0 75%, #fff 0) 0 0/16px 16px }
  #cv-wrap .corner { position:absolute; width:30px; height:30px; margin:-15px 0 0 -15px; border-radius:50%;
                     background:#e9557dcc; border:3px solid #fff; box-shadow:0 1px 5px rgba(0,0,0,.4); cursor:grab; touch-action:none }
  #cv-wrap .corner[hidden] { display:none }`;
