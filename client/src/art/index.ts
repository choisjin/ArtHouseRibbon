import * as THREE from "three";
import { Stage, fetchCatalog } from "../tv/stage";
import type { WallMount } from "../world/room";
import { renderNow, type Catalog, type Layout, type LayoutArt, type WorldRender } from "../world/types";
import { CROP_CSS, CROP_HTML, mountCrop, type Artwork } from "./crop";

/**
 * 아이 전시실 꾸미기 (?mode=art).
 *
 * **TV 에 보이는 그대로 보면서 건다** (2026-09-21): 벽을 하나씩 골라 평면으로 보던 것을 접고, TV 와 같은 3D 방을
 * 띄워 그 위에서 그림을 끌어 옮긴다. 끄는 동안 다른 벽으로 넘어가면 그 벽으로 옮겨 걸린다.
 *   - 작품 목록과 사진 올리기는 모달(🖼 작품)로
 *   - 고른 그림은 아래 막대에서 크기·액자를 바꾸고 내린다. 비율은 그대로이고, 벽을 넘는 크기로는 못 키운다
 *   - 사진 다듬기(네모로 펴기 · AI 로 오리기)는 crop.ts. 이미 올린 사진도 다시 다듬을 수 있다
 *   - 전시실은 1실·2실·3실… 로 늘릴 수 있고(kid-<id>@2), 실마다 조명 밝기를 따로 둔다
 *   - 🔗 공유: 부모님께 보낼 주소를 복사한다 (/?mode=gallery&k=열쇠, 보기 전용 — gallery/index.ts)
 * 저장하면 그 아이 전시실(kid-<아이 id>)의 arts 만 바뀐다. 배경은 모든 아이가 같은 렌더(kidbase)를 쓰므로
 * 다시 렌더할 필요가 없고, TV 가 그 배경 위에 그림만 실시간으로 그린다.
 */

interface Kid { id: string; name: string }

const MIN_W = 0.15;                       // 그림 가로 (m). 가장 큰 크기는 걸린 벽이 정한다 (maxWidth)
const WALL_FILL = 0.96;                   // 벽을 꽉 채우지는 않게
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
  let hall = 1, halls = 1;
  let light = 1;
  let layout: Layout | null = null;
  let render: WorldRender | null | undefined = null;
  let arts: LayoutArt[] = [];
  let mine: Artwork[] = [];
  let mounts: WallMount[] = [];
  let picked: string | null = null;
  let dirty = false;
  const lightIn = $<HTMLInputElement>("#light");

  const loop = (): void => { requestAnimationFrame(loop); marker?.update(); stage.render(); };
  requestAnimationFrame(loop);

  async function loadKid(): Promise<void> {
    const kid = kidSel.value;
    location.hash = kid;
    const d = await api<{ room: string; hall: number; halls: number; layout: Layout | null; artworks: Artwork[] }>(
      "GET", `/api/kids/${encodeURIComponent(kid)}/gallery?hall=${hall}`);
    room = d.room;
    hall = d.hall;
    halls = d.halls;
    layout = d.layout;
    light = d.layout?.light ?? 1;
    lightIn.value = String(light);
    drawHalls();
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
    const lay = layout ? { ...layout, arts, light } : { items: [], doll_spot: { x: 0, y: 0 }, arts, light };
    // 배경 렌더가 있으면 TV 는 렌더에 쓴 배치로 짓는다 (stage.setWorld). 손보는 중인 그림을 거기에도 넣어 준다
    const now = renderNow(render);
    await stage.setWorld(room, lay, now ? { ...now, layout: now.layout ? { ...now.layout, arts, light } : lay } : now);
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
  let grab = { u: 0, v: 0 };

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

  /** 그 벽에 걸 수 있는 가장 큰 가로 (m): 비율을 지킨 채 벽의 가로·세로를 넘지 않게 */
  function maxWidth(a: { aspect: number }, w: WallMount | undefined): number {
    if (!w) return 3;
    const U = stage.room.U;
    return Math.max(MIN_W, Math.min(w.width / U, w.height / U / a.aspect) * WALL_FILL);
  }

  /** 그림이 벽 밖으로 나가지 않게 크기와 자리를 가둔다 */
  function fit(a: LayoutArt, w: WallMount | undefined): void {
    if (!w) return;
    const U = stage.room.U;
    a.width = clamp(a.width, MIN_W, maxWidth(a, w));
    const h = a.width * a.aspect;
    const halfU = Math.max(0, w.width / U / 2 - a.width / 2);
    a.u = clamp(a.u ?? 0, -halfU, halfU);
    a.v = clamp(a.v ?? 1.5, h / 2, Math.max(h / 2, w.height / U - h / 2));
  }

  /** 지금 가리키는 벽과 그 위 자리 (m) */
  function spotAt(): { wall: WallMount; u: number; v: number } | null {
    const hit = ray.intersectObjects(walls.children, false)[0];
    if (!hit) return null;
    const w = mounts.find((x) => x.key === hit.object.userData.wall);
    if (!w) return null;
    const d = hit.point.clone().sub(w.o);
    return { wall: w, u: d.dot(w.right) / stage.room.U, v: d.dot(w.up) / stage.room.U };
  }

  canvas.onpointerdown = (ev) => {
    aim(ev);
    const a = artAt();
    picked = a?.id ?? null;
    markPicked();
    if (!a) return;
    dragging = a;
    // 잡은 곳과 그림 가운데의 차이를 기억한다 (잡자마자 가운데로 튀지 않게)
    const spot = spotAt();
    const same = spot && spot.wall.key === wallOf(a)?.key;
    grab = same ? { u: (a.u ?? 0) - spot.u, v: (a.v ?? 1.5) - spot.v } : { u: 0, v: 0 };
    canvas.setPointerCapture(ev.pointerId);
  };
  canvas.onpointermove = (ev) => {
    if (!dragging) return;
    aim(ev);
    const spot = spotAt();
    if (!spot) return;
    const was = dragging.width;
    dragging.mount = { host: spot.wall.host, id: spot.wall.id };
    dragging.u = spot.u + grab.u;
    dragging.v = spot.v + grab.v;
    fit(dragging, spot.wall);                  // 작은 벽으로 넘어가면 그 벽에 맞게 줄어든다
    dirty = true;
    if (dragging.width !== was) findArt(dragging.id)?.scale.multiplyScalar(dragging.width / was);
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
            <button data-act="cut">다듬기</button>
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
    const art: LayoutArt = {
      id: `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      image: a.file, width: w.defaultSize ?? 0.8, aspect: a.height / a.width, frame: "white",
      mount: { host: w.host, id: w.id }, u: 0, v: 1.5,
    };
    fit(art, w);
    arts.push(art);
    picked = art.id;
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

  // ---------- 고른 그림: 크기 · 액자 ----------
  // 높이 막대는 없다: 자리는 끌어서 정하고, 크기는 비율 그대로 벽 안에서만 바뀐다
  function drawPicked(): void {
    const box = $("#picked");
    const a = arts.find((x) => x.id === picked);
    if (!a) { box.hidden = true; box.innerHTML = ""; return; }
    const w = wallOf(a);
    const maxW = maxWidth(a, w);
    const name = mine.find((x) => x.file === a.image)?.name ?? "작품";
    box.hidden = false;
    box.innerHTML = `
      <b class="who">${esc(name)}</b>
      <label class="grow">크기 <button data-step="-0.05">−</button>
        <input id="w" type="range" min="${MIN_W}" max="${maxW.toFixed(2)}" step="0.01" value="${a.width}">
        <button data-step="0.05">＋</button> <b id="w-num"></b></label>
      <label>액자 <select id="frame">${FRAMES.map((f) =>
        `<option value="${f}" ${a.frame === f ? "selected" : ""}>${FRAME_NAME[f!]}</option>`).join("")}</select></label>
      <button id="down" class="ghost">벽에서 내리기</button>`;
    const wIn = box.querySelector<HTMLInputElement>("#w")!;
    const base = a.width;
    const g = findArt(a.id);
    const nums = (): void => {
      box.querySelector("#w-num")!.textContent = `${a.width.toFixed(2)}×${(a.width * a.aspect).toFixed(2)}m`;
    };
    nums();
    let timer = 0;
    const later = (): void => { clearTimeout(timer); timer = window.setTimeout(() => void rebuild(), 150); };
    const sized = (width: number): void => {
      // 끄는 동안은 3D 그림을 늘렸다 줄였다 보여 주고, 손을 떼면 액자까지 정확히 다시 짓는다
      a.width = width;
      fit(a, w);                                // 커지면서 벽 밖으로 나가면 안쪽으로 밀어 넣는다
      g?.scale.setScalar(a.width / base);
      placeLive(a);
      nums();
      dirty = true;
    };
    wIn.oninput = () => sized(Number(wIn.value));
    wIn.onchange = later;
    box.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((b) => {
      b.onclick = () => {
        sized(a.width + Number(b.dataset.step));
        wIn.value = String(a.width);
        later();
      };
    });
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

  // ---------- 전시실 1실 · 2실 · 3실 ----------
  function drawHalls(): void {
    const box = $("#halls");
    box.innerHTML = Array.from({ length: halls }, (_, i) =>
      `<button data-hall="${i + 1}" class="${i + 1 === hall ? "on" : ""}">${i + 1}실</button>`).join("")
      + `<button data-act="add" title="전시실 늘리기">＋</button>`
      + (halls > 1 ? `<button data-act="del" class="ghost" title="마지막 실 없애기">−</button>` : "");
    box.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.onclick = () => void (b.dataset.hall ? goHall(Number(b.dataset.hall)) : setHalls(b.dataset.act === "add" ? halls + 1 : halls - 1));
    });
  }

  async function goHall(n: number): Promise<void> {
    if (n === hall) return;
    try {
      if (dirty) await save();                  // 실을 옮길 때는 묻지 않고 저장한다
      hall = n;
      await loadKid();
    } catch (e) { msg(String(e), true); }
  }

  async function setHalls(count: number): Promise<void> {
    if (count < halls && !confirm(`${halls}실을 없앨까요? 그 방에 걸어 둔 그림은 벽에서 내려집니다 (사진은 남아요).`)) return;
    try {
      if (dirty) await save();
      const r = await api<{ halls: number }>("PUT", `/api/kids/${encodeURIComponent(kidSel.value)}/halls`, { count });
      if (count > halls && r.halls === halls) { msg("전시실은 더 늘릴 수 없습니다", true); return; }
      const grew = count > halls;
      hall = grew ? r.halls : Math.min(hall, r.halls);   // 늘렸으면 새 방으로 간다
      await loadKid();
      msg(grew ? `${r.halls}실을 만들었습니다` : "없앴습니다");
    } catch (e) { msg(String(e), true); }
  }

  // ---------- 조명 밝기 ----------
  lightIn.oninput = () => {
    light = Number(lightIn.value);
    stage.setLight(light);                      // 바로 보여 준다 (저장해야 TV 에도 반영된다)
    dirty = true;
  };

  // ---------- 부모님께 보낼 주소 ----------
  const shareBox = $("#share");
  $("#open-share").onclick = async () => {
    try {
      const r = await api<{ url: string }>("GET", `/api/kids/${encodeURIComponent(kidSel.value)}/share`);
      $<HTMLInputElement>("#share-url").value = r.url;
      $("#share-note").textContent = "";
      shareBox.classList.add("open");
    } catch (e) { msg(String(e), true); }
  };
  $("#share-copy").onclick = async () => {
    const input = $<HTMLInputElement>("#share-url");
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      $("#share-note").textContent = "복사했습니다. 메신저에 붙여 넣어 보내세요.";
    } catch {
      $("#share-note").textContent = "주소를 길게 눌러 복사하세요.";   // http 로 열었거나 권한이 없을 때
    }
  };
  $("#share-close").onclick = () => shareBox.classList.remove("open");
  shareBox.onclick = (ev) => { if (ev.target === shareBox) shareBox.classList.remove("open"); };

  // ---------- 저장 / TV ----------
  async function save(): Promise<void> {
    await api("PUT", `/api/world/layout?room=${encodeURIComponent(room)}`,
              { ...(layout ?? { items: [] }), arts, light });
    dirty = false;
  }
  $("#save").onclick = async () => {
    try { await save(); msg("저장했습니다"); } catch (e) { msg(String(e), true); }
  };
  $("#show").onclick = async () => {
    try {
      if (dirty) await save();
      await api("POST", "/api/world/visit", { kid_id: kidSel.value, hall, seconds: 120 });
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
    hall = 1;
    void loadKid();
  };
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  const upload = mountCrop(() => kidSel.value, async (entry, replaced) => {
    mine = [entry, ...mine.filter((a) => a.file !== entry.file)];
    if (replaced) {
      // 배경을 지운 사진으로 갈아 끼운다: 걸린 그림이 있으면 저장까지 한 뒤에야 옛 사진을 지울 수 있다
      const hung = arts.filter((a) => a.image === replaced.file);
      for (const a of hung) { a.image = entry.file; a.aspect = entry.height / entry.width; fit(a, wallOf(a)); }
      if (hung.length) { await save(); await rebuild(); }
      try {
        await api("POST", "/api/artworks/delete", { file: replaced.file });
        mine = mine.filter((a) => a.file !== replaced.file);
      } catch { /* 다른 실에도 걸려 있으면 옛 사진은 그대로 둔다 */ }
    }
    drawList();
    openArts(true);
    msg(`"${entry.name}" ${replaced ? "다듬었습니다" : "올렸습니다"}`);
  }, msg);

  await loadKid();
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const PAGE = `
<style>
  :root { color-scheme: dark }
  html, body { height:100%; margin:0; background:#0e0b16; overflow:hidden }
  body { font:15px/1.5 system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif; color:#f3efe9 }
  #view { position:fixed; inset:0; z-index:0 }
  [hidden] { display:none !important }
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
  #halls { display:flex; gap:4px }
  #halls button { padding:6px 10px }
  .lamp { display:flex; gap:6px; align-items:center }
  .lamp input { width:110px; accent-color:#ffd166 }
  #share-url { width:100%; box-sizing:border-box; padding:8px; border:1px solid #cdc6bd; border-radius:8px; background:#fff; color:#241f2b }
${CROP_CSS}
</style>
<div id="view"></div>
<header>
  <h1>🖼 전시실</h1>
  <select id="kid"></select>
  <span id="halls"></span>
  <button id="open-arts">🖼 작품</button>
  <label class="lamp" title="전시실 조명 밝기">💡 <input id="light" type="range" min="0.2" max="1.6" step="0.02" value="1"></label>
  <button id="save" class="on">저장</button>
  <button id="show">TV 에서 보기</button>
  <button id="open-share">🔗 공유</button>
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
    <p class="hint">사진을 고르면 AI 가 작품을 찾아 반듯하게 펴거나 모양대로 오려 줍니다. 이미 올린 사진도 '다듬기'로 다시 할 수 있어요.</p>
  </div>
</div>
<div id="share" class="modal">
  <div class="box">
    <div class="row"><h2>부모님께 보낼 주소</h2><span class="grow"></span><button id="share-close" class="ghost">닫기</button></div>
    <input id="share-url" readonly>
    <p class="hint">이 주소로 들어오면 로그인 없이 전시실을 볼 수 있습니다. 꾸미기는 안 되고, 작품을 누르면 크게 보고 내려받을 수 있어요.</p>
    <div class="row"><span class="hint" id="share-note"></span><span class="grow"></span><button id="share-copy" class="on">주소 복사</button></div>
  </div>
</div>
${CROP_HTML}`;
