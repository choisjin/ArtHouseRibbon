import * as THREE from "three";
import { Stage, fetchCatalog } from "../tv/stage";
import type { WallMount } from "../world/room";
import { renderNow, type Catalog, type Layout, type LayoutArt, type WorldRender } from "../world/types";

/**
 * 아이 전시실 꾸미기 (?mode=art).
 *
 * **TV 에 보이는 그대로 보면서 건다** (2026-09-21): 벽을 하나씩 골라 평면으로 보던 것을 접고, TV 와 같은 3D 방을
 * 띄워 그 위에서 그림을 끌어 옮긴다. 끄는 동안 다른 벽으로 넘어가면 그 벽으로 옮겨 걸린다.
 *   - 작품 목록과 사진 올리기는 모달(🖼 작품)로
 *   - 고른 그림은 아래 막대에서 크기·높이·액자를 바꾸고 내린다 (크기는 슬라이더 + 작게/크게)
 *   - 이미 올린 사진도 배경을 지울 수 있다 (폰으로 찍어 보낸 작품 사진 정리용)
 * 저장하면 그 아이 전시실(kid-<아이 id>)의 arts 만 바뀐다. 배경은 모든 아이가 같은 렌더(kidbase)를 쓰므로
 * 다시 렌더할 필요가 없고, TV 가 그 배경 위에 그림만 실시간으로 그린다.
 */

interface Kid { id: string; name: string }
interface Artwork { file: string; name: string; width: number; height: number; kid_id?: string | null }

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
  if (new URLSearchParams(location.search).has("embed")) document.getElementById("adminLink")?.remove();   // 관리자 '맵' 탭 안
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
  const msg = (t: string, err = false) => {
    const el = $("#msg");
    el.textContent = t;
    el.style.color = err ? "#ffb4b4" : "#e6ded6";
  };

  const kids = await api<Kid[]>("GET", "/api/kids");
  const kidSel = $<HTMLSelectElement>("#kid");
  // 고를 곳: 방(맵 편집기로 간다) + 아이들 전시실
  const rooms = await api<{ catalog: Catalog }>("GET", "/api/world")
    .then((w) => Object.entries(w.catalog.rooms ?? {}).map(([id, r]) => [id, r.name] as [string, string]))
    .catch(() => [["classroom", "미술실"], ["gallery", "전시장"]] as [string, string][]);
  kidSel.innerHTML = `<optgroup label="방">${rooms.map(([id, n]) => `<option value="room:${id}">${esc(n)}</option>`).join("")}</optgroup>`
    + `<optgroup label="아이들 전시실">${[...kids].sort((a, b) => a.name.localeCompare(b.name, "ko"))
      .map((k) => `<option value="${k.id}">🖼 ${esc(k.name)} 전시실</option>`).join("")}</optgroup>`;
  const wanted = new URLSearchParams(location.search).get("kid") || location.hash.slice(1);
  kidSel.value = wanted && kids.some((k) => k.id === wanted) ? wanted : kids[0]?.id ?? "";
  let curKid = kidSel.value;
  if (!kids.length) { msg("관리자 페이지에서 아이를 먼저 추가하세요", true); return; }

  // ---------- TV 와 같은 3D 화면 ----------
  const stage = new Stage($("#view"), await fetchCatalog());
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const walls = new THREE.Group();                 // 끌어 놓을 벽면 (보이지 않는 판)
  stage.scene.add(walls);
  let marker: THREE.BoxHelper | null = null;       // 고른 그림 테두리

  let room = "";
  let layout: Layout | null = null;
  let render: WorldRender | null | undefined = null;
  let arts: LayoutArt[] = [];
  let mine: Artwork[] = [];
  let mounts: WallMount[] = [];
  let picked: string | null = null;
  let dirty = false;

  const loop = (): void => { requestAnimationFrame(loop); marker?.update(); stage.render(); };
  requestAnimationFrame(loop);

  async function loadKid(): Promise<void> {
    const kid = kidSel.value;
    location.hash = kid;
    const d = await api<{ room: string; layout: Layout | null; artworks: Artwork[] }>(
      "GET", `/api/kids/${encodeURIComponent(kid)}/gallery`);
    room = d.room;
    layout = d.layout;
    arts = (d.layout?.arts ?? []).map((a) => ({ ...a }));
    mine = d.artworks;
    picked = null;
    dirty = false;
    render = await api<{ render?: WorldRender | null }>("GET", `/api/world/view?room=${encodeURIComponent(room)}`)
      .then((w) => w.render).catch(() => null);
    await rebuild();
    drawList();
    msg("");
  }

  /** 3D 방을 다시 짓는다 (그림을 걸거나 크기를 바꾼 뒤) */
  async function rebuild(): Promise<void> {
    const lay = layout ? { ...layout, arts } : { items: [], doll_spot: { x: 0, y: 0 }, arts };
    // 배경 렌더가 있으면 TV 는 렌더에 쓴 배치로 짓는다 (stage.setWorld). 손보는 중인 그림을 거기에도 넣어 준다
    const now = renderNow(render);
    await stage.setWorld(room, lay, now ? { ...now, layout: now.layout ? { ...now.layout, arts } : lay } : now);
    mounts = stage.room.wallMounts();
    buildWallPlanes();
    markPicked();
  }

  /** 끌어 놓을 자리: 벽마다 보이지 않는 판을 하나씩 (여기에 대고 좌표를 잡는다) */
  function buildWallPlanes(): void {
    walls.clear();
    for (const w of mounts) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w.width, w.height), mat);
      // 벽면 원점은 바닥 가운데다. 판은 가운데가 중심이라 위로 절반 올린다
      mesh.position.copy(w.o).addScaledVector(w.up, w.height / 2);
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(w.right, w.up, w.normal));
      mesh.userData.wall = w.key;
      mesh.renderOrder = -1;
      walls.add(mesh);
    }
  }

  function findArt(id: string): THREE.Object3D | undefined {
    let found: THREE.Object3D | undefined;
    stage.room.group.traverse((o) => { if (!found && o.userData.art === id) found = o; });
    return found;
  }

  const wallOf = (a: LayoutArt): WallMount | undefined =>
    mounts.find((w) => w.key === `${a.mount.host ?? "#room"}:${a.mount.id}`);

  /** 끄는 동안 그림을 바로 옮겨 보여 준다 (놓으면 rebuild 로 정확하게 다시 짓는다) */
  function placeLive(a: LayoutArt): void {
    const g = findArt(a.id);
    const w = wallOf(a);
    if (!g || !w) return;
    const U = stage.room.U;
    g.position.copy(w.o).addScaledVector(w.right, (a.u ?? 0) * U).addScaledVector(w.up, (a.v ?? 1.5) * U);
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(w.right, w.up, w.normal));
  }

  function markPicked(): void {
    if (marker) { stage.scene.remove(marker); marker = null; }
    const g = picked ? findArt(picked) : undefined;
    if (g) {
      marker = new THREE.BoxHelper(g, 0xe9557d);
      (marker.material as THREE.LineBasicMaterial).depthTest = false;
      marker.renderOrder = 10;
      stage.scene.add(marker);
    }
    drawPicked();
  }

  // ---------- 3D 에서 고르고 끌기 ----------
  const canvas = stage.renderer.domElement;
  canvas.style.touchAction = "none";
  let dragging: LayoutArt | null = null;

  function aim(ev: PointerEvent): void {
    const r = canvas.getBoundingClientRect();
    pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(pointer, stage.camera);
  }

  function artAt(): LayoutArt | null {
    for (const hit of ray.intersectObject(stage.room.group, true)) {
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
        const id = o.userData.art as string | undefined;
        if (id) return arts.find((a) => a.id === id) ?? null;
      }
    }
    return null;
  }

  /** 지금 가리키는 벽과 그 위 자리 (m). 그림이 벽 밖으로 나가지 않게 가둔다 */
  function spotAt(a: LayoutArt): { wall: WallMount; u: number; v: number } | null {
    const hit = ray.intersectObjects(walls.children, false)[0];
    if (!hit) return null;
    const w = mounts.find((x) => x.key === hit.object.userData.wall);
    if (!w) return null;
    const U = stage.room.U;
    const d = hit.point.clone().sub(w.o);
    const h = a.width * a.aspect;
    const halfU = Math.max(0, w.width / U / 2 - a.width / 2);
    return {
      wall: w,
      u: clamp(d.dot(w.right) / U, -halfU, halfU),
      v: clamp(d.dot(w.up) / U, h / 2, Math.max(h / 2, w.height / U - h / 2)),
    };
  }

  canvas.onpointerdown = (ev) => {
    aim(ev);
    const a = artAt();
    picked = a?.id ?? null;
    markPicked();
    if (!a) return;
    dragging = a;
    canvas.setPointerCapture(ev.pointerId);
  };
  canvas.onpointermove = (ev) => {
    if (!dragging) return;
    aim(ev);
    const spot = spotAt(dragging);
    if (!spot) return;
    dragging.mount = { host: spot.wall.host, id: spot.wall.id };
    dragging.u = spot.u;
    dragging.v = spot.v;
    dirty = true;
    placeLive(dragging);
  };
  const drop = (): void => {
    if (!dragging) return;
    dragging = null;
    drawPicked();
    void rebuild();
  };
  canvas.onpointerup = drop;
  canvas.onpointercancel = drop;

  // ---------- 작품 모달 (목록 · 사진 올리기) ----------
  const artsBox = $("#arts");
  const openArts = (on: boolean) => artsBox.classList.toggle("open", on);
  $("#open-arts").onclick = () => { drawList(); openArts(true); };
  $("#close-arts").onclick = () => openArts(false);
  artsBox.onclick = (ev) => { if (ev.target === artsBox) openArts(false); };

  function drawList(): void {
    const box = $("#list");
    if (!mine.length) {
      box.innerHTML = `<p class="hint">아직 올린 작품이 없습니다. 아래에서 사진을 올려 보세요.</p>`;
      return;
    }
    box.innerHTML = mine.map((a) => {
      const hung = arts.filter((x) => x.image === a.file).length;
      return `<div class="card" data-file="${esc(a.file)}">
        <img src="/${esc(a.file)}" alt="">
        <div class="card-body">
          <b>${esc(a.name)}</b>
          <small>${a.width}×${a.height}${hung ? ` · 걸린 것 ${hung}개` : ""}</small>
          <div class="row wrap">
            <button data-act="hang" class="on">벽에 걸기</button>
            <button data-act="cut">배경 지우기</button>
            <button data-act="del" class="ghost">삭제</button>
          </div>
        </div>
      </div>`;
    }).join("");
    box.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.onclick = () => {
        const file = (b.closest("[data-file]") as HTMLElement).dataset.file!;
        const a = mine.find((x) => x.file === file);
        if (!a) return;
        if (b.dataset.act === "hang") void hang(a);
        else if (b.dataset.act === "cut") { openArts(false); void upload.edit(a); }
        else void removeArtwork(a);
      };
    });
  }

  async function hang(a: Artwork): Promise<void> {
    const w = mounts[0];
    if (!w) { msg("걸 수 있는 벽이 없습니다", true); return; }
    const aspect = a.height / a.width;
    const width = clamp(w.defaultSize ?? 0.8, MIN_W, MAX_W);
    const wallH = w.height / stage.room.U;
    arts.push({
      id: `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      image: a.file, width, aspect, frame: "white",
      mount: { host: w.host, id: w.id }, u: 0,
      v: clamp(1.5, width * aspect / 2, Math.max(width * aspect / 2, wallH - width * aspect / 2)),
    });
    picked = arts[arts.length - 1].id;
    dirty = true;
    openArts(false);
    await rebuild();
    msg("걸었습니다. 끌어서 옮기고 아래에서 크기를 바꾸세요");
  }

  async function removeArtwork(a: Artwork): Promise<void> {
    if (arts.some((x) => x.image === a.file)) { msg("먼저 벽에서 내려 주세요", true); return; }
    if (!confirm(`"${a.name}" 사진을 지울까요?`)) return;
    try {
      await api("POST", "/api/artworks/delete", { file: a.file });
      mine = mine.filter((x) => x.file !== a.file);
      drawList();
      msg("지웠습니다");
    } catch (e) { msg(String(e), true); }
  }

  // ---------- 고른 그림: 크기 · 높이 · 액자 ----------
  function drawPicked(): void {
    const box = $("#picked");
    const a = arts.find((x) => x.id === picked);
    if (!a) { box.hidden = true; box.innerHTML = ""; return; }
    const w = wallOf(a);
    const wallH = w ? w.height / stage.room.U : 2.4;
    const maxW = Math.min(MAX_W, w ? w.width / stage.room.U : MAX_W);
    const name = mine.find((x) => x.file === a.image)?.name ?? "작품";
    box.hidden = false;
    box.innerHTML = `
      <b class="who">${esc(name)}</b>
      <label class="grow">크기 <button data-step="-0.05">−</button>
        <input id="w" type="range" min="${MIN_W}" max="${maxW.toFixed(2)}" step="0.01" value="${a.width}">
        <button data-step="0.05">＋</button> <b id="w-num"></b></label>
      <label class="grow">높이 <input id="v" type="range" min="0.3" max="${wallH.toFixed(2)}" step="0.01" value="${a.v ?? 1.5}">
        <b id="v-num"></b></label>
      <label>액자 <select id="frame">${FRAMES.map((f) =>
        `<option value="${f}" ${a.frame === f ? "selected" : ""}>${FRAME_NAME[f!]}</option>`).join("")}</select></label>
      <button id="down" class="ghost">벽에서 내리기</button>`;
    const wIn = box.querySelector<HTMLInputElement>("#w")!;
    const vIn = box.querySelector<HTMLInputElement>("#v")!;
    const base = a.width;
    const g = findArt(a.id);
    const nums = (): void => {
      box.querySelector("#w-num")!.textContent = `${a.width.toFixed(2)}×${(a.width * a.aspect).toFixed(2)}m`;
      box.querySelector("#v-num")!.textContent = `${(a.v ?? 1.5).toFixed(2)}m`;
    };
    nums();
    let timer = 0;
    const later = (): void => { clearTimeout(timer); timer = window.setTimeout(() => void rebuild(), 150); };
    const sized = (): void => {
      // 끄는 동안은 3D 그림을 늘렸다 줄였다 보여 주고, 손을 떼면 액자까지 정확히 다시 짓는다
      g?.scale.setScalar(a.width / base);
      a.v = clamp(a.v ?? 1.5, a.width * a.aspect / 2, Math.max(a.width * a.aspect / 2, wallH - a.width * a.aspect / 2));
      vIn.value = String(a.v);
      placeLive(a);
      nums();
      dirty = true;
    };
    wIn.oninput = () => { a.width = clamp(Number(wIn.value), MIN_W, maxW); sized(); };
    wIn.onchange = later;
    box.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((b) => {
      b.onclick = () => {
        a.width = clamp(a.width + Number(b.dataset.step), MIN_W, maxW);
        wIn.value = String(a.width);
        sized();
        later();
      };
    });
    vIn.oninput = () => {
      a.v = Number(vIn.value);
      dirty = true;
      placeLive(a);
      nums();
    };
    box.querySelector<HTMLSelectElement>("#frame")!.onchange = (e) => {
      a.frame = (e.target as HTMLSelectElement).value as LayoutArt["frame"];
      dirty = true;
      void rebuild();
    };
    box.querySelector<HTMLButtonElement>("#down")!.onclick = () => {
      arts = arts.filter((x) => x.id !== a.id);
      picked = null;
      dirty = true;
      void rebuild();
      drawList();
    };
  }

  // ---------- 저장 / TV ----------
  async function save(): Promise<void> {
    await api("PUT", `/api/world/layout?room=${encodeURIComponent(room)}`,
              { ...(layout ?? { items: [] }), arts });
    dirty = false;
  }
  $("#save").onclick = async () => {
    try { await save(); msg("저장했습니다"); } catch (e) { msg(String(e), true); }
  };
  $("#show").onclick = async () => {
    try {
      if (dirty) await save();
      await api("POST", "/api/world/visit", { kid_id: kidSel.value, seconds: 120 });
      msg("TV 가 이 전시실을 보러 갑니다 (2분 뒤 교실로)");
    } catch (e) { msg(String(e), true); }
  };
  kidSel.onchange = () => {
    if (dirty && !confirm("저장하지 않은 것이 있습니다. 옮길까요?")) { kidSel.value = curKid; return; }
    if (kidSel.value.startsWith("room:")) {
      const embed = new URLSearchParams(location.search).has("embed") ? "&embed=1" : "";
      location.href = `/?mode=editor${embed}#${kidSel.value.slice(5)}`;
      return;
    }
    curKid = kidSel.value;
    void loadKid();
  };
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  const upload = mountUpload(() => kidSel.value, async (entry, replaced) => {
    mine = [entry, ...mine.filter((a) => a.file !== entry.file)];
    if (replaced) {
      // 배경을 지운 사진으로 갈아 끼운다: 걸린 그림이 있으면 저장까지 한 뒤에야 옛 사진을 지울 수 있다
      const hung = arts.filter((a) => a.image === replaced.file);
      for (const a of hung) { a.image = entry.file; a.aspect = entry.height / entry.width; }
      if (hung.length) { await save(); await rebuild(); }
      try {
        await api("POST", "/api/artworks/delete", { file: replaced.file });
        mine = mine.filter((a) => a.file !== replaced.file);
      } catch { /* 다른 방에도 걸려 있으면 옛 사진은 그대로 둔다 */ }
    }
    drawList();
    openArts(true);
    msg(`"${entry.name}" ${replaced ? "배경을 지웠습니다" : "올렸습니다"}`);
  }, msg);

  await loadKid();
}

// =====================================================================
// 사진 올리기 + 배경 지우기
// =====================================================================
const MAX_SIDE = 1600;          // 올리기 전에 이 크기로 줄인다 (사진이 너무 크면 느리다)

interface Upload { edit(a: Artwork): Promise<void> }

function mountUpload(kidId: () => string, done: (a: Artwork, replaced?: Artwork) => Promise<void>,
                     msg: (t: string, e?: boolean) => void): Upload {
  const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
  const file = $<HTMLInputElement>("#file");
  const dlg = $<HTMLDivElement>("#crop");
  const canvas = $<HTMLCanvasElement>("#cv");
  const tol = $<HTMLInputElement>("#tol");
  const useCut = $<HTMLInputElement>("#cut");
  let src: ImageData | null = null;        // 줄인 원본
  let out: HTMLCanvasElement | null = null;
  let replacing: Artwork | null = null;    // 이미 올린 사진의 배경을 지우는 중이면 그 작품

  const open = (img: HTMLImageElement, name: string, replaced: Artwork | null): void => {
    const c = shrink(img, MAX_SIDE);
    src = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    replacing = replaced;
    $("#crop-name").textContent = name;
    $("#crop-ok").textContent = replaced ? "바꾸기" : "올리기";
    dlg.classList.add("open");
    apply();
  };

  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    try { open(await readImage(f), f.name, null); } catch (e) { msg(String(e), true); }
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
  const close = (): void => { dlg.classList.remove("open"); src = null; replacing = null; };
  $("#crop-cancel").onclick = close;
  $("#crop-ok").onclick = async () => {
    if (!out) return;
    const name = ($("#crop-name").textContent || "작품").replace(/\.[^.]+$/, "");
    const data = out.toDataURL("image/png");
    const replaced = replacing;
    try {
      const r = await api<{ artwork: Artwork }>("POST", "/api/artworks",
        { name, data, width: out.width, height: out.height, kid_id: kidId() });
      close();
      await done(r.artwork, replaced ?? undefined);
    } catch (e) { msg(String(e), true); }
  };

  return {
    async edit(a: Artwork): Promise<void> {
      try {
        const img = await loadImage(`/${a.file}`);
        open(img, a.name, a);
        useCut.checked = true;
        apply();
      } catch (e) { msg(String(e), true); }
    },
  };
}

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
  :root { color-scheme: dark }
  html, body { height:100%; margin:0; background:#0e0b16; overflow:hidden }
  body { font:15px/1.5 system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif; color:#f3efe9 }
  #view { position:fixed; inset:0; z-index:0 }
  select, input, button { font:inherit }
  select, input[type=number] { padding:5px 7px; border:1px solid #4a4356; border-radius:7px; background:#241f2b; color:#f3efe9 }
  button { padding:6px 12px; border:1px solid #4a4356; border-radius:8px; background:#241f2b; color:#f3efe9; cursor:pointer }
  button.on { background:#e9557d; border-color:#e9557d; color:#fff }
  button.ghost { color:#c9b7bd }
  button:hover { border-color:#e9557d }
  header { position:fixed; z-index:3; top:0; left:0; right:0; display:flex; gap:10px; align-items:center;
           padding:10px 14px; background:linear-gradient(#0e0b16ee,#0e0b1600); flex-wrap:wrap }
  header h1 { font-size:16px; margin:0 4px 0 0 }
  header a { color:#c9b7bd }
  #msg { margin-left:auto; font-size:14px; color:#e6ded6 }
  #picked { position:fixed; z-index:3; left:12px; right:12px; bottom:12px; display:flex; gap:14px; align-items:center;
            flex-wrap:wrap; padding:10px 14px; border-radius:14px; background:#1b1724ee; border:1px solid #3a3346 }
  #picked[hidden] { display:none }
  #picked label { display:flex; gap:6px; align-items:center; white-space:nowrap }
  #picked .grow { flex:1 1 220px }
  #picked input[type=range] { flex:1; min-width:110px; accent-color:#e9557d }
  #picked .who { color:#f0b9c8 }
  #picked button[data-step] { padding:2px 10px }
  .modal { display:none; position:fixed; inset:0; z-index:5; background:rgba(10,8,16,.66);
           align-items:center; justify-content:center; padding:16px }
  .modal.open { display:flex }
  .modal .box { background:#f6f4f1; color:#241f2b; border-radius:14px; padding:16px; width:min(520px,94vw);
                max-height:86vh; overflow:auto; display:flex; flex-direction:column; gap:10px }
  .modal .box button { background:#fff; color:#241f2b; border-color:#cdc6bd }
  .modal .box button.on { background:#e9557d; border-color:#e9557d; color:#fff }
  .modal h2 { font-size:16px; margin:0 }
  .row { display:flex; gap:8px; align-items:center }
  .row.wrap { flex-wrap:wrap }
  .grow { flex:1 }
  .hint { color:#8b8279; font-size:13px; margin:6px 0 }
  .card { display:flex; gap:10px; padding:8px; border:1px solid #e3ded8; border-radius:10px; margin-bottom:8px }
  .card img { width:72px; height:72px; object-fit:contain; background:#fff; border-radius:6px }
  .card-body { display:flex; flex-direction:column; gap:4px; min-width:0 }
  .card-body small { color:#8b8279 }
  #crop { z-index:6 }
  #cv { max-width:100%; align-self:center; background:
        conic-gradient(#eee 25%, #fff 0 50%, #eee 0 75%, #fff 0) 0 0/16px 16px }
</style>
<div id="view"></div>
<header>
  <h1>🖼 전시실</h1>
  <select id="kid"></select>
  <button id="open-arts">🖼 작품</button>
  <button id="save" class="on">저장</button>
  <button id="show">TV 에서 보기</button>
  <a id="adminLink" href="/?mode=admin">관리자</a>
  <span id="msg"></span>
</header>
<div id="picked" hidden></div>
<div id="arts" class="modal">
  <div class="box">
    <div class="row"><h2>작품</h2><span class="grow"></span><button id="close-arts" class="ghost">닫기</button></div>
    <div id="list"></div>
    <input id="file" type="file" accept="image/*" capture="environment" style="display:none">
    <button class="on" onclick="document.getElementById('file').click()">📷 작품 사진 올리기</button>
    <p class="hint">사진을 고르면 배경을 지우고 작품만 남길 수 있습니다. 이미 올린 사진도 '배경 지우기'로 다듬을 수 있어요.</p>
  </div>
</div>
<div id="crop" class="modal">
  <div class="box">
    <b id="crop-name"></b>
    <canvas id="cv"></canvas>
    <label class="row"><input id="cut" type="checkbox" checked> 배경 지우기</label>
    <label class="row">지우는 정도 <input id="tol" type="range" min="2" max="60" value="16" style="flex:1"></label>
    <div class="row"><span class="hint" id="crop-size"></span>
      <span class="grow"></span>
      <button id="crop-cancel" class="ghost">취소</button>
      <button id="crop-ok" class="on">올리기</button></div>
  </div>
</div>`;
