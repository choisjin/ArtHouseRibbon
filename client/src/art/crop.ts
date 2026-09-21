import { bgOf, composeArt, DEFAULT_BG, lookSize, MAX_PAD, padOf, type Pad } from "../world/artimage";
import { frameStyle, FRAME_STYLES } from "../world/frames";

/**
 * 작품 편집 창 (전시실 꾸미기의 '사진 올리기'와 작품 목록의 '편집').
 *
 *   - **배경 지우기**: 서버(ribbon/cutout.py, BiRefNet)가 작품만 골라낸 마스크를 주고, 여기서 원본 크기로 오려 낸다.
 *     가장자리 색으로 지우던 예전 방식은 품질이 나빴다. 서버에서 모델을 못 쓰면 그 방식으로 떨어진다 ('지우는 정도' 막대).
 *   - 네 탭: **여백**(네 쪽, ± 로 미세 조정) · **배경**(뒤에 까는 색) · **액자**(종류마다 이 작품을 끼워 본 썸네일을 옆으로 넘겨 고른다) ·
 *     **설명**(이름 · 완성일 · 작품 이야기 — 부모님 전시실에서 작품과 같이 보인다)
 * 올라가는 파일은 **배경 없는 원본**(투명 PNG)이고, 여백과 배경색은 값으로만 저장한다 — 그래서 나중에 다시 편집해도
 * AI 를 또 돌리지 않고, 부모님은 배경 없는 원본도 내려받을 수 있다. 이미 올린 작품의 여백·배경색만 바꾸면
 * 파일은 그대로 두고 값만 고친다 (PUT /api/artworks/meta, 걸려 있는 곳도 서버가 같이 맞춘다).
 */

export interface Artwork {
  file: string; name: string; width: number; height: number; kid_id?: string | null;
  bg?: string; pad?: number[]; frame?: string; made?: string; note?: string;
}
export interface Cropper { edit(a: Artwork): Promise<void> }

const THUMB = 74;               // 액자 고르기 썸네일 속 그림의 긴 변 (px)
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
                          msg: (t: string, e?: boolean) => void): Cropper {
  const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
  const file = $<HTMLInputElement>("#file");
  const dlg = $<HTMLDivElement>("#crop");
  const canvas = $<HTMLCanvasElement>("#cv");
  const status = $("#crop-status");
  const cutIn = $<HTMLInputElement>("#cut");
  const tolRow = $("#tol-row");
  const tol = $<HTMLInputElement>("#tol");
  const linkIn = $<HTMLInputElement>("#pad-link");
  const padIns = [...dlg.querySelectorAll<HTMLInputElement>("input[data-pad]")];   // 막대만 (± 단추는 따로)
  const bgIn = $<HTMLInputElement>("#bg");
  const nameIn = $<HTMLInputElement>("#crop-title");
  const madeIn = $<HTMLInputElement>("#crop-made");
  const noteIn = $<HTMLTextAreaElement>("#crop-note");

  let src: ImageData | null = null;        // 줄인 원본
  let srcCanvas: HTMLCanvasElement | null = null;
  let alpha: Uint8ClampedArray | null = null;   // 작품이면 255 (원본 크기)
  let cutCanvas: HTMLCanvasElement | null = null;   // 오려 낸 결과 (alpha 가 바뀔 때만 다시 만든다)
  let useColor = false;                    // AI 를 못 써서 색으로 지우는 중
  let pad: Pad = [0, 0, 0, 0];
  let bg = DEFAULT_BG;
  let frame = "white";
  let editing: Artwork | null = null;      // 이미 올린 작품을 편집하는 중이면 그 작품
  let tab = "pad";                         // 보고 있는 탭 (액자 탭일 때만 썸네일을 다시 그린다)
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
    frame = old?.frame ?? "white";
    bgIn.value = bg;
    nameIn.value = old?.name ?? name.replace(/\.[^.]+$/, "");
    madeIn.value = old?.made ?? new Date().toLocaleDateString("sv-SE");   // 새 사진은 오늘
    noteIn.value = old?.note ?? "";
    padIns.forEach((el, i) => { el.value = String(Math.round(pad[i] * 100)); });
    linkIn.checked = pad.every((v) => v === pad[0]);
    tolRow.hidden = true;
    // 이미 배경이 지워진 작품(투명한 곳이 있다)은 다시 지우지 않는다. 새 사진이나 통짜 사진은 지운다
    cutIn.checked = !hasHoles(src);
    $("#crop-ok").textContent = old ? "저장" : "올리기";
    dlg.classList.add("open");
    session++;
    status.textContent = "";
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
        setAlpha(keepBig(m, src.width, src.height), "");
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

  // ---------- 미리 보기: 배경색 위에 여백을 두고, 둘레에 액자를 둘러 ----------
  function draw(): void {
    const pic = picture();
    if (!pic) return;
    const look = { bg, pad };
    const full = lookSize(pic.width, pic.height, look);
    const room = (canvas.parentElement!.parentElement?.clientWidth || 480) - 2;
    const s = Math.min(1, room / full.w, window.innerHeight * 0.34 / full.h);
    const shown = composeArt(pic, pic.width, pic.height, look, Math.max(full.w, full.h) * s);
    canvas.width = shown.width;
    canvas.height = shown.height;
    canvas.getContext("2d")!.drawImage(shown, 0, 0);
    frameAround(canvas, frameStyle(frame), Math.max(shown.width, shown.height));
    if (tab === "frame") drawFrames();
    $("#crop-size").textContent = `${Math.round(full.w)}×${Math.round(full.h)}`;
    dlg.querySelectorAll<HTMLElement>("[data-color]").forEach((b) => b.classList.toggle("on", b.dataset.color === bg));
    padIns.forEach((el, i) => { el.parentElement!.querySelector("b")!.textContent = `${Math.round(pad[i] * 100)}%`; });
  }

  const setPad = (i: number, percent: number): void => {
    const v = Math.min(MAX_PAD, Math.max(0, percent / 100));
    if (linkIn.checked) { pad = [v, v, v, v]; padIns.forEach((o) => { o.value = String(Math.round(v * 100)); }); }
    else { pad[i] = v; padIns[i].value = String(Math.round(v * 100)); }
    draw();
  };
  padIns.forEach((el, i) => { el.oninput = () => setPad(i, Number(el.value)); });
  dlg.querySelectorAll<HTMLButtonElement>("[data-padstep]").forEach((b) => {
    const i = Number(b.dataset.pad), step = Number(b.dataset.padstep);
    b.onclick = () => setPad(i, Number(padIns[i].value) + step);
  });
  dlg.querySelectorAll<HTMLButtonElement>(".c-tabs button").forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.tab ?? "pad";
      dlg.querySelectorAll<HTMLElement>(".c-tabs button").forEach((t) => t.classList.toggle("on", t === b));
      dlg.querySelectorAll<HTMLElement>(".c-body").forEach((t) => { t.hidden = t.dataset.tab !== tab; });
      if (tab === "frame") drawFrames();
    };
  });

  /** 액자 탭: 종류마다 이 작품을 끼워 본 썸네일 (옆으로 넘겨 고른다) */
  function drawFrames(): void {
    const pic = picture();
    if (!pic) return;
    const base = composeArt(pic, pic.width, pic.height, { bg, pad }, THUMB);
    const box = $("#frame-slides");
    box.innerHTML = FRAME_STYLES.map((f) =>
      `<button data-frame="${f.id}" class="${f.id === frame ? "on" : ""}"><span class="f-pic"></span>
        <span class="f-name">${f.name}</span></button>`).join("");
    box.querySelectorAll<HTMLButtonElement>("[data-frame]").forEach((b, i) => {
      const f = FRAME_STYLES[i];
      const c = document.createElement("canvas");
      c.width = base.width;
      c.height = base.height;
      c.getContext("2d")!.drawImage(base, 0, 0);
      frameAround(c, f, Math.max(base.width, base.height));
      b.querySelector(".f-pic")!.appendChild(c);
      b.onclick = () => {
        frame = f.id;
        box.querySelectorAll<HTMLElement>("[data-frame]").forEach((o) => o.classList.toggle("on", o === b));
        draw();
      };
      if (f.id === frame) setTimeout(() => b.scrollIntoView({ block: "nearest", inline: "center" }), 0);
    });
  }
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
  /** 창에 적힌 값들 (올리기·저장에 같이 보낸다) */
  const text = () => ({ bg, pad, frame, name: nameIn.value.trim() || "작품", made: madeIn.value, note: noteIn.value.trim() });

  $("#crop-cancel").onclick = close;
  $("#crop-ok").onclick = async () => {
    const pic = picture();
    if (!pic) return;
    const old = editing;
    const ok = $<HTMLButtonElement>("#crop-ok");
    ok.disabled = true;
    try {
      if (old && pic === srcCanvas) {
        // 그림은 그대로, 여백·배경색만: 파일을 다시 올리지 않는다
        const r = await send<{ artwork?: Artwork; detail?: string }>("PUT", "/api/artworks/meta", { file: old.file, ...text() });
        if (r.status !== 200 || !r.data.artwork) throw new Error(r.data.detail || `저장하지 못했습니다 (${r.status})`);
        close();
        await done(r.data.artwork, old);
        return;
      }
      // 투명한 곳이 있으면 PNG (통짜 사진은 JPEG 가 훨씬 가볍다)
      const data = pic === cutCanvas ? pic.toDataURL("image/png") : pic.toDataURL("image/jpeg", 0.92);
      const r = await send<{ artwork?: Artwork; detail?: string }>("POST", "/api/artworks",
        { data, width: pic.width, height: pic.height, kid_id: kidId(), ...text() });
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
    <div id="cv-wrap"><canvas id="cv"></canvas></div>
    <p class="hint" id="crop-status"></p>
    <div class="row">
      <label class="row"><input id="cut" type="checkbox" checked> 배경 지우기 (AI)</label>
      <span class="grow"></span>
      <span class="hint" id="crop-size"></span>
      <button id="crop-cancel" class="ghost">취소</button>
      <button id="crop-ok" class="on">올리기</button>
    </div>
    <label class="row" id="tol-row" hidden>지우는 정도 <input id="tol" type="range" min="2" max="60" value="16" style="flex:1"></label>
    <div class="c-tabs">
      <button data-tab="pad" class="on">여백</button>
      <button data-tab="bg">배경</button>
      <button data-tab="frame">액자</button>
      <button data-tab="note">설명</button>
    </div>
    <div class="c-body pads" data-tab="pad">
      <label class="row four"><input id="pad-link" type="checkbox" checked> 네 쪽 같이</label>
      ${SIDES.map((n, i) => `<label class="row">
        <span class="p-name">${n}</span>
        <button data-pad="${i}" data-padstep="-1" class="step">−</button>
        <input data-pad="${i}" type="range" min="0" max="${MAX_PAD * 100}" step="1" value="0">
        <button data-pad="${i}" data-padstep="1" class="step">＋</button>
        <b>0%</b></label>`).join("")}
    </div>
    <div class="c-body row wrap" data-tab="bg" hidden>
      <span>배경색</span> <input id="bg" type="color" value="${DEFAULT_BG}"> <span id="swatches" class="row"></span>
    </div>
    <div class="c-body col" data-tab="frame" hidden>
      <div id="frame-slides"></div>
      <span class="hint">벽에 걸었을 때 이 액자로 보입니다.</span>
    </div>
    <div class="c-body notes" data-tab="note" hidden>
      <label class="row">이름 <input id="crop-title" type="text" maxlength="80" placeholder="작품 이름"></label>
      <label class="row">완성일 <input id="crop-made" type="date"></label>
      <label class="row top">설명 <textarea id="crop-note" rows="3" maxlength="600"
        placeholder="어떤 작품인지, 무엇을 그렸는지 적어 두면 부모님 전시실에서 같이 보입니다"></textarea></label>
    </div>
  </div>
</div>`;

export const CROP_CSS = `
  #crop { z-index:6 }
  #crop .box { width:min(600px,94vw) }
  #crop .box > * { flex:0 0 auto }        /* 창이 좁아도 줄이지 말고 창을 굴리게 */
  #cv-wrap { align-self:center; line-height:0 }
  #cv { max-width:100%; box-shadow:0 1px 8px rgba(0,0,0,.25) }
  #crop .c-tabs { display:flex; gap:6px; flex-wrap:wrap; border-top:1px solid #e3ded8; padding-top:10px }
  #crop .c-tabs button { padding:6px 16px }
  #crop .c-body { min-height:96px; align-content:start }
  #crop .c-body.col { display:flex; flex-direction:column; gap:6px }
  /* 액자 고르기: 이 작품을 끼워 본 썸네일을 옆으로 넘긴다 */
  #frame-slides { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px }
  #frame-slides button { flex:0 0 auto; width:104px; padding:6px 4px; display:flex; flex-direction:column;
                         align-items:center; gap:4px; background:#fff }
  #frame-slides button.on { border-color:#e9557d; box-shadow:0 0 0 2px #e9557d55 }
  #frame-slides .f-pic { display:flex; align-items:center; justify-content:center; height:94px }
  #frame-slides canvas { max-width:96px; max-height:94px }
  #frame-slides .f-name { font-size:11px; color:#8b8279; text-align:center; line-height:1.25 }
  #crop .c-body[hidden] { display:none }
  /* 네 쪽 막대를 같은 길이로 (한 줄에 하나씩), 양 끝의 ± 로 1% 씩 */
  #crop .pads { display:flex; flex-direction:column; gap:6px }
  #crop .pads .p-name { min-width:3em }
  #crop .pads input[type=range] { flex:1; min-width:80px }
  #crop .c-tabs button, #crop .box button { height:30px }
  #crop .step { width:30px; padding:0; text-align:center }
  #crop .pads b { min-width:3em; text-align:right }
  #crop .notes { display:flex; flex-direction:column; gap:8px }
  #crop .notes textarea { resize:vertical; min-height:64px }
  #crop .notes input[type=text], #crop .notes textarea { flex:1; padding:6px 8px; border:1px solid #cdc6bd;
                                                         border-radius:8px; background:#fff; color:#241f2b; font:inherit }
  #crop .notes .row.top { align-items:flex-start }
  #crop .notes .row > :first-child { min-width:3.4em }
  #bg { width:44px; height:32px; padding:0; border:1px solid #cdc6bd; border-radius:6px; background:#fff }
  #swatches button { width:28px; height:28px; padding:0; border-radius:50%; border:2px solid #cdc6bd }
  #swatches button.on { border-color:#e9557d; box-shadow:0 0 0 2px #e9557d55 }
`;

/**
 * 미리 보기 둘레에 액자를 그린다 (벽에 거는 3D 액자를 납작하게 흉내 낸 것: 매트 · 테두리 · 그림자).
 * 캔버스를 액자만큼 키우고 가운데에 그림을 다시 그린다
 */
function frameAround(canvas: HTMLCanvasElement, f: ReturnType<typeof frameStyle>, side: number): void {
  const mm = (v: number) => (v / 1000) * side * 1.1;      // 1m 쯤 되는 그림으로 치고 mm 를 px 로
  const mat = mm(f.mat ?? 0), gap = mm(f.gap ?? 0), bar = mm(f.width);
  if (!mat && !gap && !bar) return;
  const pic = document.createElement("canvas");
  pic.width = canvas.width;
  pic.height = canvas.height;
  pic.getContext("2d")!.drawImage(canvas, 0, 0);
  const pad = Math.round(mat + gap + bar);
  canvas.width = pic.width + pad * 2;
  canvas.height = pic.height + pad * 2;
  const ctx = canvas.getContext("2d")!;
  const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
  if (bar) {                                             // 액자 테두리
    ctx.fillStyle = hex(f.color);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0,0,0,.18)";                   // 안쪽 턱 그늘
    ctx.fillRect(bar, bar, canvas.width - bar * 2, canvas.height - bar * 2);
  }
  if (mat || gap) {
    ctx.fillStyle = mat ? hex(f.matColor ?? 0xfbfaf6) : "#0c0c0d";
    ctx.fillRect(bar, bar, canvas.width - bar * 2, canvas.height - bar * 2);
  }
  ctx.drawImage(pic, pad, pad);
}

