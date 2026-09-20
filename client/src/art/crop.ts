import { bgOf, composeArt, DEFAULT_BG, lookSize, MAX_PAD, padOf, type Pad } from "../world/artimage";

/**
 * 작품 편집 창 (전시실 꾸미기의 '사진 올리기'와 작품 목록의 '편집').
 *
 *   - **배경 지우기**: 서버(ribbon/cutout.py, BiRefNet)가 작품만 골라낸 마스크를 주고, 여기서 원본 크기로 오려 낸다.
 *     가장자리 색으로 지우던 예전 방식은 품질이 나빴다. 서버에서 모델을 못 쓰면 그 방식으로 떨어진다 ('지우는 정도' 막대).
 *   - **여백**: 위·아래·왼쪽·오른쪽을 따로 (긴 변의 %). '네 쪽 같이'를 켜 두면 하나만 움직여도 같이 바뀐다.
 *   - **배경색**: 오려 낸 작품 뒤에 까는 색. 정하지 않으면 흰색 (world/artimage.ts).
 * 올라가는 파일은 **배경 없는 원본**(투명 PNG)이고, 여백과 배경색은 값으로만 저장한다 — 그래서 나중에 다시 편집해도
 * AI 를 또 돌리지 않고, 부모님은 배경 없는 원본도 내려받을 수 있다. 이미 올린 작품의 여백·배경색만 바꾸면
 * 파일은 그대로 두고 값만 고친다 (PUT /api/artworks/meta, 걸려 있는 곳도 서버가 같이 맞춘다).
 * 이미 올린 작품을 편집할 때는 여기서 지울 수도 있다 (벽에 걸려 있으면 먼저 내려야 한다).
 */

export interface Artwork {
  file: string; name: string; width: number; height: number; kid_id?: string | null;
  bg?: string; pad?: number[];
}
export interface Cropper { edit(a: Artwork): Promise<void> }

const MAX_SIDE = 2000;          // 올리기 전에 이 크기로 줄인다 (부모님이 크게 볼 수 있을 만큼은 남긴다)
const AI_SIDE = 1024;           // AI 에 보내는 크기 (모델 입력이 1024 라 더 커도 소용없다)
const SWATCHES = ["#ffffff", "#faf5ea", "#eeeeee", "#222222", "#fbdce4", "#dcecf9", "#fff1c2", "#dff2df"];
const SIDES = ["왼쪽", "위", "오른쪽", "아래"];

async function send<T>(method: string, url: string, body: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({})) as T;
  return { status: res.status, data };
}

export function mountCrop(kidId: () => string, done: (a: Artwork, replaced?: Artwork) => Promise<void>,
                          msg: (t: string, e?: boolean) => void,
                          remove: (a: Artwork) => Promise<boolean>): Cropper {
  const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
  const file = $<HTMLInputElement>("#file");
  const dlg = $<HTMLDivElement>("#crop");
  const canvas = $<HTMLCanvasElement>("#cv");
  const status = $("#crop-status");
  const cutIn = $<HTMLInputElement>("#cut");
  const tolRow = $("#tol-row");
  const tol = $<HTMLInputElement>("#tol");
  const linkIn = $<HTMLInputElement>("#pad-link");
  const padIns = [...dlg.querySelectorAll<HTMLInputElement>("[data-pad]")];
  const bgIn = $<HTMLInputElement>("#bg");

  let src: ImageData | null = null;        // 줄인 원본
  let srcCanvas: HTMLCanvasElement | null = null;
  let alpha: Uint8ClampedArray | null = null;   // 작품이면 255 (원본 크기)
  let cutCanvas: HTMLCanvasElement | null = null;   // 오려 낸 결과 (alpha 가 바뀔 때만 다시 만든다)
  let useColor = false;                    // AI 를 못 써서 색으로 지우는 중
  let pad: Pad = [0, 0, 0, 0];
  let bg = DEFAULT_BG;
  let editing: Artwork | null = null;      // 이미 올린 작품을 편집하는 중이면 그 작품
  let session = 0;                         // 창을 닫았다 다시 열면 늦게 온 AI 답은 버린다

  $("#swatches").innerHTML = SWATCHES.map((c) => `<button data-color="${c}" style="background:${c}" title="${c}"></button>`).join("");

  const open = (img: HTMLImageElement, name: string, old: Artwork | null): void => {
    srcCanvas = shrink(img, MAX_SIDE);
    src = srcCanvas.getContext("2d")!.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    alpha = null;
    cutCanvas = null;
    useColor = false;
    editing = old;
    pad = [...padOf(old)] as Pad;
    bg = bgOf(old);
    bgIn.value = bg;
    padIns.forEach((el, i) => { el.value = String(Math.round(pad[i] * 100)); });
    linkIn.checked = pad.every((v) => v === pad[0]);
    tolRow.hidden = true;
    // 이미 배경이 지워진 작품(투명한 곳이 있다)은 다시 지우지 않는다. 새 사진이나 통짜 사진은 지운다
    cutIn.checked = !hasHoles(src);
    $("#crop-name").textContent = name;
    $("#crop-ok").textContent = old ? "저장" : "올리기";
    $("#crop-del").hidden = !old;
    dlg.classList.add("open");
    session++;
    status.textContent = cutIn.checked ? "" : "배경이 이미 지워진 작품입니다. 여백과 배경색을 바꿀 수 있어요.";
    draw();
    if (cutIn.checked) void askAi(session);
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
    status.textContent = "AI 가 배경을 지우는 중…";
    const data = shrinkCanvas(srcCanvas, AI_SIDE).toDataURL("image/jpeg", 0.9);
    for (let tries = 0; tries < 200; tries++) {
      let r: { status: number; data: { mask?: string; progress?: number } };
      try { r = await send("POST", "/api/cutout", { data }); } catch { r = { status: 0, data: {} }; }
      if (my !== session || !src) return;
      if (r.status === 200 && r.data.mask) {
        const m = await maskToAlpha(r.data.mask, src.width, src.height);
        if (my !== session || !src) return;
        setAlpha(keepBig(m, src.width, src.height), "배경을 지웠습니다. 여백과 배경색을 맞춰 보세요.");
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
    setAlpha(colorMask(src, Number(tol.value)), "AI 를 쓸 수 없어 색으로 지웁니다. '지우는 정도'를 맞춰 보세요.");
  }

  function setAlpha(a: Uint8ClampedArray, note: string): void {
    if (!src) return;
    alpha = a;
    cutCanvas = cutOut(src, a);
    status.textContent = note;
    draw();
  }

  /** 지금 올라갈 그림 (배경을 지웠으면 오려 낸 것, 아니면 원본) */
  const picture = (): HTMLCanvasElement | null => (cutIn.checked && cutCanvas ? cutCanvas : srcCanvas);

  // ---------- 미리 보기: 배경색 위에 여백을 두고 ----------
  function draw(): void {
    const pic = picture();
    if (!pic) return;
    const look = { bg, pad };
    const full = lookSize(pic.width, pic.height, look);
    const room = (canvas.parentElement!.parentElement?.clientWidth || 480) - 2;
    const s = Math.min(1, room / full.w, window.innerHeight * 0.42 / full.h);
    const shown = composeArt(pic, pic.width, pic.height, look, Math.max(full.w, full.h) * s);
    canvas.width = shown.width;
    canvas.height = shown.height;
    canvas.getContext("2d")!.drawImage(shown, 0, 0);
    $("#crop-size").textContent = `${Math.round(full.w)}×${Math.round(full.h)}`;
    dlg.querySelectorAll<HTMLElement>("[data-color]").forEach((b) => b.classList.toggle("on", b.dataset.color === bg));
    padIns.forEach((el, i) => { el.parentElement!.querySelector("b")!.textContent = `${Math.round(pad[i] * 100)}%`; });
  }

  padIns.forEach((el, i) => {
    el.oninput = () => {
      const v = Math.min(MAX_PAD, Number(el.value) / 100);
      if (linkIn.checked) { pad = [v, v, v, v]; padIns.forEach((o) => { o.value = el.value; }); } else pad[i] = v;
      draw();
    };
  });
  linkIn.onchange = () => {
    if (!linkIn.checked) return;
    pad = [pad[0], pad[0], pad[0], pad[0]];
    padIns.forEach((o) => { o.value = String(Math.round(pad[0] * 100)); });
    draw();
  };
  bgIn.oninput = () => { bg = bgIn.value; draw(); };
  $("#swatches").onclick = (ev) => {
    const c = (ev.target as HTMLElement).dataset.color;
    if (!c) return;
    bg = c;
    bgIn.value = c;
    draw();
  };
  cutIn.onchange = () => {
    tolRow.hidden = !(cutIn.checked && useColor);
    if (cutIn.checked && !alpha) void askAi(session);
    else draw();
  };
  tol.oninput = () => { if (useColor && src) setAlpha(colorMask(src, Number(tol.value)), status.textContent ?? ""); };
  window.addEventListener("resize", () => { if (dlg.classList.contains("open")) draw(); });

  const close = (): void => {
    dlg.classList.remove("open");
    src = null; srcCanvas = null; alpha = null; cutCanvas = null; editing = null;
    session++;
  };
  $("#crop-cancel").onclick = close;
  $("#crop-del").onclick = async () => {
    const old = editing;
    if (old && await remove(old)) close();
  };
  $("#crop-ok").onclick = async () => {
    const pic = picture();
    if (!pic) return;
    const old = editing;
    const ok = $<HTMLButtonElement>("#crop-ok");
    ok.disabled = true;
    try {
      if (old && pic === srcCanvas) {
        // 그림은 그대로, 여백·배경색만: 파일을 다시 올리지 않는다
        const r = await send<{ artwork?: Artwork; detail?: string }>("PUT", "/api/artworks/meta", { file: old.file, bg, pad });
        if (r.status !== 200 || !r.data.artwork) throw new Error(r.data.detail || `저장하지 못했습니다 (${r.status})`);
        close();
        await done(r.data.artwork, old);
        return;
      }
      const name = ($("#crop-name").textContent || "작품").replace(/\.[^.]+$/, "");
      // 투명한 곳이 있으면 PNG (통짜 사진은 JPEG 가 훨씬 가볍다)
      const data = pic === cutCanvas ? pic.toDataURL("image/png") : pic.toDataURL("image/jpeg", 0.92);
      const r = await send<{ artwork?: Artwork; detail?: string }>("POST", "/api/artworks",
        { name, data, width: pic.width, height: pic.height, kid_id: kidId(), bg, pad });
      if (r.status !== 200 || !r.data.artwork) throw new Error(r.data.detail || `올리지 못했습니다 (${r.status})`);
      if (old && old.file !== r.data.artwork.file) {
        // 새로 오려 낸 그림으로 갈아 끼운다: 걸려 있던 곳도 서버가 모두 바꾸고 옛 파일을 지운다
        const sw = await send<{ detail?: string }>("POST", "/api/artworks/replace", { old: old.file, new: r.data.artwork.file });
        if (sw.status !== 200) throw new Error(sw.data.detail || `바꾸지 못했습니다 (${sw.status})`);
      }
      close();
      await done(r.data.artwork, old ?? undefined);
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
  ctx.fillStyle = "#fff";                     // 이미 투명한 사진을 다시 지울 때 (JPEG 는 투명이 검게 된다)
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** 투명한 곳이 있는 그림인가 (이미 배경을 지운 작품) */
function hasHoles(d: ImageData): boolean {
  const px = d.data;
  let n = 0, seen = 0;
  for (let i = 3; i < px.length; i += 4 * 7) {   // 7 픽셀마다 하나씩만 본다
    seen++;
    if (px[i] < 200) n++;
  }
  return n > seen * 0.01;
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

/** 마스크대로 투명하게 만들고 남은 곳에 딱 맞게 자른다 (여백은 나중에 따로 둔다) */
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

/** 전시실 꾸미기 화면에 넣는 편집 창 (art/index.ts 의 PAGE 에 들어간다) */
export const CROP_HTML = `
<div id="crop" class="modal">
  <div class="box">
    <b id="crop-name"></b>
    <div id="cv-wrap"><canvas id="cv"></canvas></div>
    <p class="hint" id="crop-status"></p>
    <label class="row"><input id="cut" type="checkbox" checked> 배경 지우기 (AI)</label>
    <label class="row" id="tol-row" hidden>지우는 정도 <input id="tol" type="range" min="2" max="60" value="16" style="flex:1"></label>
    <div class="pads">
      <div class="row"><b>여백</b><span class="grow"></span><label class="row"><input id="pad-link" type="checkbox" checked> 네 쪽 같이</label></div>
      ${SIDES.map((n, i) => `<label class="row">${n} <input data-pad="${i}" type="range" min="0" max="${MAX_PAD * 100}" step="1" value="0" style="flex:1"> <b>0%</b></label>`).join("")}
    </div>
    <div class="row wrap"><b>배경색</b> <input id="bg" type="color" value="${DEFAULT_BG}"> <span id="swatches" class="row"></span></div>
    <div class="row"><span class="hint" id="crop-size"></span>
      <span class="grow"></span>
      <button id="crop-del" class="ghost" hidden>작품 지우기</button>
      <button id="crop-cancel" class="ghost">취소</button>
      <button id="crop-ok" class="on">올리기</button></div>
  </div>
</div>`;

export const CROP_CSS = `
  #crop { z-index:6 }
  #crop .box { width:min(600px,94vw) }
  #cv-wrap { align-self:center; line-height:0 }
  #cv { max-width:100%; box-shadow:0 1px 8px rgba(0,0,0,.25) }
  #crop .pads { display:grid; grid-template-columns:1fr 1fr; gap:4px 16px }
  #crop .pads > .row:first-child { grid-column:1 / -1 }
  #crop .pads label b { min-width:2.6em; text-align:right }
  #bg { width:44px; height:32px; padding:0; border:1px solid #cdc6bd; border-radius:6px; background:#fff }
  #swatches button { width:28px; height:28px; padding:0; border-radius:50%; border:2px solid #cdc6bd }
  #swatches button.on { border-color:#e9557d; box-shadow:0 0 0 2px #e9557d55 }
  @media (max-width:520px) { #crop .pads { grid-template-columns:1fr } }`;
