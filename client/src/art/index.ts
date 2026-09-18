import type { Catalog, LayoutArt, MountSpec, RoomInfo } from "../world/types";

/**
 * 아이 전시실 꾸미기 (?mode=art). 맵 편집기와 따로 둔 이유는 여기서 하는 일이 다르기 때문이다.
 *   - 찍어 온 작품 사진을 올리고 (배경 지우기로 종이만 남기고)
 *   - 전시실 벽을 정면에서 본 그림으로 놓고 끌어서 옮기고, 모서리를 끌어 크기를 바꾼다 (비율 고정)
 * 저장하면 그 아이 전시실(kid-<아이 id>)의 arts 만 바뀐다. 배경은 모든 아이가 같은 렌더를 쓰므로
 * 다시 렌더할 필요가 없고, TV 가 그 배경 위에 그림만 실시간으로 그린다.
 */

interface Kid { id: string; name: string }
interface Artwork { file: string; name: string; width: number; height: number; kid_id?: string | null }

const U_DEFAULT = 2.2222;                 // 1m 가 장면 단위로 몇인지 (카탈로그가 알려준다)
const MIN_W = 0.15, MAX_W = 3.0;          // 그림 가로 (m)
const FRAMES: LayoutArt["frame"][] = ["canvas", "white", "wood", "black"];
const FRAME_NAME: Record<string, string> = { canvas: "테두리 없음", white: "흰 액자", wood: "나무 액자", black: "검은 액자" };

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || `${res.status}`);
  return (await res.json()) as T;
}

export async function startArt(): Promise<void> {
  document.body.innerHTML = PAGE;
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
  const msg = (t: string, err = false) => {
    const el = $("#msg");
    el.textContent = t;
    el.style.color = err ? "#c33" : "#268";
  };

  const kids = await api<Kid[]>("GET", "/api/kids");
  const kidSel = $<HTMLSelectElement>("#kid");
  kidSel.innerHTML = kids.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join("");
  const wanted = new URLSearchParams(location.search).get("kid") || location.hash.slice(1);
  if (wanted && kids.some((k) => k.id === wanted)) kidSel.value = wanted;
  if (!kids.length) { msg("관리자 페이지에서 아이를 먼저 추가하세요", true); return; }

  let room = "";
  let arts: LayoutArt[] = [];
  let mine: Artwork[] = [];
  let mounts: MountSpec[] = [];
  let U = U_DEFAULT;
  let wall = "back";
  let picked: string | null = null;
  let dirty = false;

  async function loadKid(): Promise<void> {
    const kid = kidSel.value;
    location.hash = kid;
    const d = await api<{ room: string; layout: { arts: LayoutArt[]; shell?: string } | null;
                         artworks: Artwork[]; catalog: Catalog }>(
      "GET", `/api/kids/${encodeURIComponent(kid)}/gallery`);
    room = d.room;
    arts = (d.layout?.arts ?? []).map((a) => ({ ...a }));
    mine = d.artworks;
    const info = (d.catalog.rooms as Record<string, RoomInfo>)[d.layout?.shell ?? "gallery"];
    U = info?.unit_per_m || U_DEFAULT;
    mounts = (info?.mounts ?? []).filter((m) => !m.ledge);
    if (!mounts.some((m) => m.id === wall)) wall = mounts[0]?.id ?? "back";
    picked = null;
    dirty = false;
    drawWallTabs();
    drawList();
    drawWall();
    msg(`${arts.length}점 걸려 있음`);
  }

  // ---------- 왼쪽: 올린 작품 ----------
  function drawList(): void {
    const box = $("#list");
    if (!mine.length) { box.innerHTML = `<p class="hint">아직 올린 작품이 없습니다. 아래에서 사진을 올려 보세요.</p>`; return; }
    box.innerHTML = mine.map((a) => {
      const hung = arts.filter((x) => x.image === a.file).length;
      return `<div class="card" data-file="${esc(a.file)}">
        <img src="/${esc(a.file)}" alt="">
        <div class="card-body">
          <b>${esc(a.name)}</b>
          <small>${a.width}×${a.height}${hung ? ` · 벽에 ${hung}개` : ""}</small>
          <div class="row">
            <button data-act="hang">벽에 걸기</button>
            <button data-act="del" class="ghost">삭제</button>
          </div>
        </div>
      </div>`;
    }).join("");
    box.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.onclick = () => {
        const file = (b.closest("[data-file]") as HTMLElement).dataset.file!;
        if (b.dataset.act === "hang") hang(file); else void removeArtwork(file);
      };
    });
  }

  function hang(file: string): void {
    const a = mine.find((x) => x.file === file);
    if (!a) return;
    const m = mounts.find((x) => x.id === wall)!;
    const width = Math.min(MAX_W, Math.max(MIN_W, 0.8));
    arts.push({
      id: `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      image: file, width, aspect: a.height / a.width, frame: "white",
      mount: { host: null, id: wall }, u: 0, v: Math.min((m.height / U) - width * (a.height / a.width) / 2 - 0.2, 1.5),
    });
    picked = arts[arts.length - 1].id;
    dirty = true;
    drawWall();
    drawList();
    msg("벽에 걸었습니다. 끌어서 옮기고 모서리를 끌어 크기를 바꾸세요");
  }

  async function removeArtwork(file: string): Promise<void> {
    if (arts.some((a) => a.image === file)) { msg("벽에서 먼저 내려 주세요", true); return; }
    if (!confirm("이 작품 사진을 지울까요?")) return;
    try {
      await api("POST", "/api/artworks/delete", { file });
      mine = mine.filter((a) => a.file !== file);
      drawList();
      msg("지웠습니다");
    } catch (e) { msg(String(e), true); }
  }

  // ---------- 오른쪽: 벽 ----------
  function drawWallTabs(): void {
    const box = $("#walls");
    box.innerHTML = mounts.map((m) =>
      `<button data-wall="${esc(m.id)}" class="${m.id === wall ? "on" : ""}">${esc(m.name)}</button>`).join("");
    box.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.onclick = () => { wall = b.dataset.wall!; picked = null; drawWallTabs(); drawWall(); };
    });
  }

  /** 벽을 정면에서 본 그림. 1m = px 몇인지는 벽 폭에 맞춰 정한다 */
  function drawWall(): void {
    const m = mounts.find((x) => x.id === wall);
    const view = $("#wall");
    if (!m) { view.innerHTML = ""; return; }
    const wm = m.width / U, hm = m.height / U;
    const px = Math.max(200, view.clientWidth - 24) / wm;      // px per meter
    view.style.height = `${hm * px + 24}px`;
    const here = arts.filter((a) => a.mount.id === wall);
    view.innerHTML = `<div class="wall-inner" style="width:${wm * px}px;height:${hm * px}px">
      <div class="floorline"></div>
      ${here.map((a) => {
        const w = a.width * px, h = a.width * a.aspect * px;
        const left = (wm / 2 + (a.u ?? 0)) * px - w / 2;
        const bottom = (a.v ?? 1.5) * px - h / 2;
        return `<div class="art ${a.id === picked ? "on" : ""}" data-id="${a.id}"
                  style="left:${left}px;bottom:${bottom}px;width:${w}px;height:${h}px">
          <img src="/${esc(a.image)}" draggable="false" alt="">
          <span class="grip"></span>
        </div>`;
      }).join("")}
    </div>
    <div class="scale">${wm.toFixed(1)}m × ${hm.toFixed(1)}m 벽</div>`;
    view.querySelectorAll<HTMLElement>(".art").forEach((el) => bindDrag(el, px, wm));
    drawPicked();
  }

  /** 끌어서 옮기기 / 모서리를 끌어 비율 그대로 크기 바꾸기 */
  function bindDrag(el: HTMLElement, px: number, wm: number): void {
    el.onpointerdown = (ev) => {
      ev.preventDefault();
      const a = arts.find((x) => x.id === el.dataset.id);
      if (!a) return;
      picked = a.id;
      drawPicked();
      const resize = (ev.target as HTMLElement).classList.contains("grip");
      const sx = ev.clientX, sy = ev.clientY;
      const u0 = a.u ?? 0, v0 = a.v ?? 1.5, w0 = a.width;
      el.setPointerCapture(ev.pointerId);
      const move = (e: PointerEvent) => {
        const dx = (e.clientX - sx) / px, dy = (sy - e.clientY) / px;
        if (resize) {
          // 가로만 보고 늘린다 → 세로는 비율대로 따라온다 (비율 고정)
          a.width = clamp(w0 + dx, MIN_W, Math.min(MAX_W, wm - 0.1));
        } else {
          const h = a.width * a.aspect;
          a.u = clamp(u0 + dx, -(wm - a.width) / 2, (wm - a.width) / 2);
          a.v = clamp(v0 + dy, h / 2, ($("#wall").clientHeight / px) - h / 2);
        }
        dirty = true;
        place(el, a, px, wm);
        drawPicked();
      };
      const up = () => { el.onpointermove = null; el.onpointerup = null; };
      el.onpointermove = move;
      el.onpointerup = up;
      el.onpointercancel = up;
    };
  }

  function place(el: HTMLElement, a: LayoutArt, px: number, wm: number): void {
    const w = a.width * px, h = a.width * a.aspect * px;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.left = `${(wm / 2 + (a.u ?? 0)) * px - w / 2}px`;
    el.style.bottom = `${(a.v ?? 1.5) * px - h / 2}px`;
  }

  /** 고른 그림의 크기·높이·액자를 아래쪽에 보여 준다 */
  function drawPicked(): void {
    const box = $("#picked");
    const a = arts.find((x) => x.id === picked);
    document.querySelectorAll(".art").forEach((el) => el.classList.toggle("on", (el as HTMLElement).dataset.id === picked));
    if (!a) { box.innerHTML = `<p class="hint">그림을 누르면 여기에서 크기와 액자를 바꿀 수 있습니다.</p>`; return; }
    const h = a.width * a.aspect;
    box.innerHTML = `<div class="row wrap">
      <label>가로 <input id="w" type="number" min="${MIN_W}" max="${MAX_W}" step="0.05" value="${a.width.toFixed(2)}">m</label>
      <span class="hint">세로 ${h.toFixed(2)}m (비율 고정)</span>
      <label>높이 <input id="v" type="number" step="0.05" value="${(a.v ?? 1.5).toFixed(2)}">m</label>
      <label>액자 <select id="frame">${FRAMES.map((f) =>
        `<option value="${f}" ${a.frame === f ? "selected" : ""}>${FRAME_NAME[f!]}</option>`).join("")}</select></label>
      <button id="down" class="ghost">벽에서 내리기</button>
    </div>`;
    const num = (id: string) => box.querySelector<HTMLInputElement>(`#${id}`)!;
    num("w").onchange = () => { a.width = clamp(Number(num("w").value), MIN_W, MAX_W); dirty = true; drawWall(); };
    num("v").onchange = () => { a.v = Number(num("v").value); dirty = true; drawWall(); };
    box.querySelector<HTMLSelectElement>("#frame")!.onchange = (e) => {
      a.frame = (e.target as HTMLSelectElement).value as LayoutArt["frame"];
      dirty = true;
    };
    box.querySelector<HTMLButtonElement>("#down")!.onclick = () => {
      arts = arts.filter((x) => x.id !== a.id);
      picked = null;
      dirty = true;
      drawWall();
      drawList();
    };
  }

  // ---------- 저장 / TV ----------
  $("#save").onclick = async () => {
    try {
      await api("PUT", `/api/world/layout?room=${encodeURIComponent(room)}`, { items: [], arts });
      dirty = false;
      msg("저장했습니다");
    } catch (e) { msg(String(e), true); }
  };
  $("#show").onclick = async () => {
    if (dirty) { msg("먼저 저장하세요", true); return; }
    try {
      await api("POST", "/api/world/visit", { kid_id: kidSel.value, seconds: 120 });
      msg("TV 가 이 전시실을 보러 갑니다 (2분 뒤 교실로)");
    } catch (e) { msg(String(e), true); }
  };
  kidSel.onchange = () => {
    if (dirty && !confirm("저장하지 않은 것이 있습니다. 옮길까요?")) { return; }
    void loadKid();
  };
  window.addEventListener("resize", () => drawWall());
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  mountUpload(() => kidSel.value, async (entry) => {
    mine = [entry, ...mine.filter((a) => a.file !== entry.file)];
    drawList();
    msg(`"${entry.name}" 올렸습니다`);
  }, msg);

  await loadKid();
}

// =====================================================================
// 사진 올리기 + 배경 지우기
// =====================================================================
const MAX_SIDE = 1600;          // 올리기 전에 이 크기로 줄인다 (사진이 너무 크면 느리다)

function mountUpload(kidId: () => string, done: (a: Artwork) => Promise<void>, msg: (t: string, e?: boolean) => void): void {
  const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
  const file = $<HTMLInputElement>("#file");
  const dlg = $<HTMLDivElement>("#crop");
  const canvas = $<HTMLCanvasElement>("#cv");
  const tol = $<HTMLInputElement>("#tol");
  const useCut = $<HTMLInputElement>("#cut");
  let src: ImageData | null = null;        // 줄인 원본
  let out: HTMLCanvasElement | null = null;

  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    try {
      const img = await readImage(f);
      const c = shrink(img, MAX_SIDE);
      src = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
      $("#crop-name").textContent = f.name;
      dlg.style.display = "flex";
      apply();
    } catch (e) { msg(String(e), true); }
  };

  function apply(): void {
    if (!src) return;
    out = useCut.checked ? removeBackground(src, Number(tol.value)) : toCanvas(src);
    const max = 420;
    const s = Math.min(1, max / Math.max(out.width, out.height));
    canvas.width = Math.round(out.width * s);
    canvas.height = Math.round(out.height * s);
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(out, 0, 0, canvas.width, canvas.height);
    $("#crop-size").textContent = `${out.width}×${out.height}`;
  }
  tol.oninput = () => { if (useCut.checked) apply(); };
  useCut.onchange = apply;
  $("#crop-cancel").onclick = () => { dlg.style.display = "none"; src = null; };
  $("#crop-ok").onclick = async () => {
    if (!out) return;
    const name = ($("#crop-name").textContent || "작품").replace(/\.[^.]+$/, "");
    const data = out.toDataURL("image/png");
    try {
      const r = await api<{ artwork: Artwork }>("POST", "/api/artworks",
        { name, data, width: out.width, height: out.height, kid_id: kidId() });
      dlg.style.display = "none";
      src = null;
      await done(r.artwork);
    } catch (e) { msg(String(e), true); }
  };
}

function readImage(f: File): Promise<HTMLImageElement> {
  return new Promise((ok, no) => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); ok(img); };
    img.onerror = () => { URL.revokeObjectURL(url); no(new Error("사진을 읽지 못했습니다")); };
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

function toCanvas(d: ImageData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = d.width;
  c.height = d.height;
  c.getContext("2d")!.putImageData(d, 0, 0);
  return c;
}

/**
 * 배경 지우기: 사진 가장자리에서 시작해 비슷한 색으로 이어진 곳을 지운다 (책상·바닥이 지워지고 작품만 남는다).
 * 지운 뒤 남은 부분에 딱 맞게 잘라낸다. tol 은 0~100, 클수록 많이 지운다.
 */
function removeBackground(src: ImageData, tol: number): HTMLCanvasElement {
  const { width: w, height: h } = src;
  const px = src.data;
  const limit = (tol / 100) * 160;              // 색 거리 한계
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => { if (!seen[i]) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  // 가장자리 색들의 평균을 배경색으로 본다
  let br = 0, bg = 0, bb = 0;
  for (const i of stack) { br += px[i * 4]; bg += px[i * 4 + 1]; bb += px[i * 4 + 2]; }
  const n = Math.max(1, stack.length);
  br /= n; bg /= n; bb /= n;

  const out = new Uint8ClampedArray(px);
  const near = (i: number) => {
    const d = Math.abs(px[i * 4] - br) + Math.abs(px[i * 4 + 1] - bg) + Math.abs(px[i * 4 + 2] - bb);
    return d <= limit * 3;
  };
  const cut = new Uint8Array(w * h);
  const work = stack.filter(near);
  for (const i of work) cut[i] = 1;
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
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < w * h; i++) {
    if (cut[i]) { out[i * 4 + 3] = 0; continue; }
    const x = i % w, y = (i - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < x0 || y1 < y0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }   // 다 지워졌으면 그대로
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const full = new ImageData(out, w, h);
  const tmp = toCanvas(full);
  c.getContext("2d")!.drawImage(tmp, x0, y0, cw, ch, 0, 0, cw, ch);
  return c;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const PAGE = `
<style>
  :root { color-scheme: light }
  body { margin:0; font:15px/1.5 system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif; background:#f6f4f1; color:#241f2b }
  header { display:flex; gap:12px; align-items:center; padding:10px 16px; background:#fff; border-bottom:1px solid #e3ded8; flex-wrap:wrap }
  header h1 { font-size:17px; margin:0 8px 0 0 }
  select, input, button { font:inherit }
  select, input[type=number] { padding:5px 7px; border:1px solid #cdc6bd; border-radius:7px; background:#fff }
  button { padding:6px 12px; border:1px solid #cdc6bd; border-radius:8px; background:#fff; cursor:pointer }
  button.on { background:#e9557d; border-color:#e9557d; color:#fff }
  button.ghost { color:#866 }
  button:hover { border-color:#e9557d }
  #msg { margin-left:auto; font-size:14px }
  main { display:grid; grid-template-columns:320px 1fr; gap:16px; padding:16px; align-items:start }
  section { background:#fff; border:1px solid #e3ded8; border-radius:12px; padding:12px }
  h2 { font-size:15px; margin:0 0 10px }
  .hint { color:#8b8279; font-size:13px; margin:6px 0 }
  .row { display:flex; gap:8px; align-items:center }
  .row.wrap { flex-wrap:wrap }
  .card { display:flex; gap:10px; padding:8px; border:1px solid #eee7df; border-radius:10px; margin-bottom:8px }
  .card img { width:72px; height:72px; object-fit:contain; background:#faf7f3; border-radius:6px }
  .card-body { display:flex; flex-direction:column; gap:4px; min-width:0 }
  .card-body small { color:#8b8279 }
  #walls { display:flex; gap:6px; margin-bottom:10px }
  #wall { position:relative; overflow:hidden }
  .wall-inner { position:relative; margin:0 auto; background:linear-gradient(#f2efe9,#e8e3db); border:1px solid #ddd6cd; border-radius:4px }
  .floorline { position:absolute; left:0; right:0; bottom:0; height:2px; background:#c9c0b5 }
  .art { position:absolute; cursor:grab; touch-action:none; box-shadow:0 2px 6px rgba(0,0,0,.18); background:#fff }
  .art img { width:100%; height:100%; object-fit:contain; display:block; pointer-events:none }
  .art.on { outline:2px solid #e9557d; outline-offset:2px }
  .art .grip { position:absolute; right:-7px; bottom:-7px; width:14px; height:14px; border-radius:50%;
               background:#e9557d; border:2px solid #fff; cursor:nwse-resize; display:none }
  .art.on .grip { display:block }
  .scale { text-align:center; color:#8b8279; font-size:12px; padding-top:6px }
  #crop { display:none; position:fixed; inset:0; background:rgba(28,24,32,.6); align-items:center; justify-content:center; z-index:9 }
  #crop .box { background:#fff; border-radius:14px; padding:16px; width:min(520px,92vw); display:flex; flex-direction:column; gap:10px }
  #cv { max-width:100%; align-self:center; background:
        conic-gradient(#eee 25%, #fff 0 50%, #eee 0 75%, #fff 0) 0 0/16px 16px }
</style>
<header>
  <h1>🖼 전시실 꾸미기</h1>
  <label>아이 <select id="kid"></select></label>
  <button id="save">저장</button>
  <button id="show">TV 에서 보기</button>
  <a href="/?mode=admin" style="color:#866">관리자 페이지</a>
  <span id="msg"></span>
</header>
<main>
  <section>
    <h2>올린 작품</h2>
    <div id="list"></div>
    <label class="row" style="margin-top:10px">
      <input id="file" type="file" accept="image/*" capture="environment" style="display:none">
      <button onclick="document.getElementById('file').click()">📷 작품 사진 올리기</button>
    </label>
    <p class="hint">사진을 고르면 배경을 지우고 작품만 남길 수 있습니다.</p>
  </section>
  <section>
    <h2>벽에 걸기</h2>
    <div id="walls"></div>
    <div id="wall"></div>
    <div id="picked"></div>
  </section>
</main>
<div id="crop">
  <div class="box">
    <b id="crop-name"></b>
    <canvas id="cv"></canvas>
    <label class="row"><input id="cut" type="checkbox" checked> 배경 지우기</label>
    <label class="row">지우는 정도 <input id="tol" type="range" min="2" max="60" value="16" style="flex:1"></label>
    <div class="row"><span class="hint" id="crop-size"></span>
      <span style="margin-left:auto"></span>
      <button id="crop-cancel" class="ghost">취소</button>
      <button id="crop-ok" class="on">올리기</button></div>
  </div>
</div>`;
