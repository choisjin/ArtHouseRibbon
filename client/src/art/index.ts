import * as THREE from "three";
import { Stage, fetchCatalog } from "../tv/stage";
import type { WallMount } from "../world/room";
import { renderNow, type Layout, type LayoutArt, type WorldRender } from "../world/types";
import { bgOf, lookSize, padOf } from "../world/artimage";
import { FRAME_STYLES } from "../world/frames";
import { FX_PRESETS, fxOf, type ArtFx } from "../world/artfx";
import { LookAround } from "../world/lookaround";
import { CROP_CSS, CROP_HTML, mountCrop, type Artwork } from "./crop";

/**
 * 아이 전시실 꾸미기 (?mode=art).
 *
  * **방 안에 서서 보면서 건다** (2026-09-21): 벽을 하나씩 골라 평면으로 보던 것을 접고, 쓸어 넘겨 둘러보는 3D 방에서
 * 그림을 끌어 옮긴다 (world/lookaround.ts). 배경은 같은 자리에서 구운 360° 파노라마라 어느 벽이든 렌더 품질 그대로다.
 *   - 아래 설정 창은 네 탭: **작품**(슬라이드로 고르기·크기·액자·올리기) · **필터** · **하이라이트** · **조명**(방 밝기)
 *   - 그림은 비율 그대로 크기만 바꾸고, 벽을 넘는 크기로는 못 키운다. 끄는 동안 다른 벽으로 넘어가면 그 벽으로 옮겨 걸린다
 *   - 작품 편집(AI 배경 지우기 · 여백 · 배경색 · 지우기)은 crop.ts. 이미 올린 작품도 다시 편집할 수 있다
 *   - 액자는 world/frames.ts, 작품마다 거는 이미지 필터와 하이라이트는 world/artfx.ts
 *   - **전시장**(모두가 같이 쓰는 방)도 여기서 꾸민다: 가구는 없고 작품만 건다. 슬라이드는 모든 아이 것을 아이별로 묶어 보여 준다
 *   - 전시실은 1실·2실·3실… 로 늘릴 수 있고(kid-<id>@2), 실마다 조명 밝기를 따로 둔다
 *   - 공유: 부모님께 보낼 주소를 복사한다 (/?mode=gallery&k=열쇠, 보기 전용 — gallery/index.ts)
 * 저장하면 그 아이 전시실(kid-<아이 id>)의 arts 만 바뀐다. 배경은 모든 아이가 같은 렌더(kidbase)를 쓰므로
 * 다시 렌더할 필요가 없고, TV 가 그 배경 위에 그림만 실시간으로 그린다.
 */

interface Kid { id: string; name: string }

type Tab = "art" | "fx" | "glow" | "light";
const GALLERY = "gallery";                // 고르는 칸에서 '전시장' 의 값 (아이 전시실은 아이 id)

const MIN_W = 0.15;                       // 그림 가로 (m). 가장 큰 크기는 걸린 벽이 정한다 (maxWidth)
const WALL_FILL = 0.96;                   // 벽을 꽉 채우지는 않게

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
    el.style.color = err ? "#ffb4b4" : "#e6ded6";
  };

  const kids = await api<Kid[]>("GET", "/api/kids");
  const kidSel = $<HTMLSelectElement>("#kid");
  // 전시장(모두의 방) + 아이들 전시실. 가구를 놓는 방(미술실)은 관리자의 맵 탭에서 따로 꾸민다
  kidSel.innerHTML = `<option value="${GALLERY}">전시장</option>`
    + [...kids].sort((a, b) => a.name.localeCompare(b.name, "ko"))
      .map((k) => `<option value="${esc(k.id)}">${esc(k.name)}</option>`).join("");
  const query = new URLSearchParams(location.search);
  const wanted = query.get("room") === "gallery" ? GALLERY : query.get("kid") || decodeURIComponent(location.hash.slice(1));
  kidSel.value = wanted === GALLERY || kids.some((k) => k.id === wanted) ? wanted : kids[0]?.id ?? GALLERY;
  let curKid = kidSel.value;
  const inGallery = (): boolean => kidSel.value === GALLERY;
  const kidName = (id: string | null | undefined): string => kids.find((k) => k.id === id)?.name ?? "아이 없음";
  const upKid = $<HTMLSelectElement>("#up-kid");   // 전시장에서 사진을 올릴 때: 누구 작품인가
  upKid.innerHTML = [...kids].sort((a, b) => a.name.localeCompare(b.name, "ko"))
    .map((k) => `<option value="${esc(k.id)}">${esc(k.name)}</option>`).join("");

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
  let tab: Tab = "art";                           // 고른 작품 설정에서 보고 있는 탭 (그림을 바꿔도 그대로)
  const lightIn = $<HTMLInputElement>("#light");

  if (new URLSearchParams(location.search).has("debug")) (window as unknown as { stage?: Stage }).stage = stage;
  stage.setLooking(true);                          // 방 가운데에 서서 둘러본다 (쓸어 넘겨 왼쪽·오른쪽 벽으로)
  const looker = new LookAround(stage, stage.renderer.domElement);
  const loop = (): void => { requestAnimationFrame(loop); looker.tick(); marker?.update(); stage.render(); };
  requestAnimationFrame(loop);

  async function loadKid(): Promise<void> {
    const kid = kidSel.value;
    location.hash = kid;
    const gallery = inGallery();
    // 전시장은 모든 아이의 작품을 걸 수 있다 (목록은 아이별로 묶는다). 실 나누기와 부모님 공유는 아이 전시실에만 있다
    const d = gallery
      ? { hall: 1, halls: 1, ...await api<{ room: string; layout: Layout | null; artworks: Artwork[] }>("GET", "/api/world?room=gallery") }
      : await api<{ room: string; hall: number; halls: number; layout: Layout | null; artworks: Artwork[] }>(
        "GET", `/api/kids/${encodeURIComponent(kid)}/gallery?hall=${hall}`);
    $("#hall-row").hidden = gallery;
    $("#open-share").hidden = gallery;
    $("#up-who").hidden = !gallery;
    room = d.room;
    hall = d.hall;
    halls = d.halls;
    layout = d.layout;
    light = d.layout?.light ?? 1;
    lightIn.value = String(light);
    showLight();
    drawHalls();
    arts = (d.layout?.arts ?? []).map((a) => ({ ...a }));
    mine = d.artworks;
    picked = null;
    dirty = false;
    render = await api<{ render?: WorldRender | null }>("GET", `/api/world/view?room=${encodeURIComponent(room)}`)
      .then((w) => w.render).catch(() => null);
    await rebuild();
    const before = JSON.stringify(arts);
    for (const a of arts) fit(a, wallOf(a));    // 편집으로 비율이 바뀌어 벽을 넘게 됐으면 안으로 들인다
    if (JSON.stringify(arts) !== before) { dirty = true; await rebuild(); }
    drawSlides();
    msg("");
    void watchPano();
  }

  /**
   * 둘러보기 배경(360° 파노라마)이 아직 없으면 알려 주고, 블렌더 렌더가 끝나는 대로 바꿔 끼운다.
   * 파노라마가 없는 동안은 방을 실시간 3D 로 그리기 때문에 렌더한 그림처럼 보이지 않는다 (서버를 새로 올린 직후가 그렇다)
   */
  let watching = false;
  async function watchPano(): Promise<void> {
    if (watching || renderNow(render)?.pano) return;
    watching = true;
    const started = Date.now();
    const here = room;
    try {
      interface Status { render: { available: boolean; running: string | null; pending: string[];
                                   last?: { room?: string; ok?: boolean } }; log?: string[] }
      let st = await api<Status>("GET", "/api/world/render");
      if (!st.render.available) {
        msg("이 서버에서 블렌더를 찾지 못해 렌더 배경 없이 실시간 3D 로 보여 줍니다 (.env 의 RIBBON_BLENDER_EXE)", true);
        return;
      }
      if (st.render.running !== "kidbase" && !st.render.pending.includes("kidbase")) {
        await api("POST", "/api/world/render?room=kidbase");        // 아이 전시실이 같이 쓰는 배경
      }
      while (room === here) {
        const secs = Math.round((Date.now() - started) / 1000);
        msg(`둘러보기 배경을 블렌더로 렌더하는 중… ${secs}초 (끝날 때까지는 임시 3D 화면입니다)`);
        await new Promise((ok) => setTimeout(ok, 6000));
        const got = await api<{ render?: WorldRender | null }>("GET", `/api/world/view?room=${encodeURIComponent(here)}`)
          .then((w) => w.render).catch(() => null);
        if (room !== here) return;
        if (renderNow(got)?.pano) {
          render = got;
          await rebuild();
          msg("렌더한 배경으로 바꿨습니다");
          return;
        }
        st = await api<Status>("GET", "/api/world/render");
        const idle = !st.render.running && !st.render.pending.length;
        if (idle && st.render.last?.room === "kidbase" && st.render.last.ok === false) {
          msg(`배경 렌더에 실패했습니다: ${(st.log ?? []).slice(-1)[0] ?? "data/world/render/render.log 를 보세요"}`, true);
          return;
        }
        if (idle && secs > 30) { msg("배경 렌더가 끝났는데 파노라마가 없습니다. 서버를 최신으로 올렸는지 확인하세요", true); return; }
      }
    } catch (e) { msg(String(e), true); } finally { watching = false; }
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
    g.updateMatrix();                           // 그림 무리는 행렬을 직접 들고 있다 (room.ts buildArt)
  }

  function markPicked(): void {
    if (marker) { stage.scene.remove(marker); marker = null; }
    const g = picked ? findArt(picked) : undefined;
    if (g) {
      marker = new THREE.BoxHelper(g.getObjectByName("art-core") ?? g, 0xe9557d);   // 그림자·빛은 빼고 그림만 두른다
      (marker.material as THREE.LineBasicMaterial).depthTest = false;
      marker.renderOrder = 10;
      stage.scene.add(marker);
    }
    syncPanel();
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
    if (!a) {                                   // 빈 곳을 잡았다: 둘러보기 (거의 안 움직이고 놓으면 고른 것을 푼다)
      if (stage.looking) looker.begin(ev);
      else { picked = null; markPicked(); }
      return;
    }
    picked = a.id;
    markPicked();
    dragging = a;
    // 잡은 곳과 그림 가운데의 차이를 기억한다 (잡자마자 가운데로 튀지 않게)
    const spot = spotAt();
    const same = spot && spot.wall.key === wallOf(a)?.key;
    grab = same ? { u: (a.u ?? 0) - spot.u, v: (a.v ?? 1.5) - spot.v } : { u: 0, v: 0 };
    canvas.setPointerCapture(ev.pointerId);
  };
  canvas.onpointermove = (ev) => {
    if (!dragging) { looker.move(ev); return; }
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
  const drop = (ev: PointerEvent): void => {
    if (!dragging) {
      const was = looker.dragging;
      looker.end(ev);
      if (was && !looker.dragging && looker.moved < 6 && picked) { picked = null; markPicked(); }
      return;
    }
    dragging = null;
    syncPanel();
    void rebuild();
  };
  canvas.onpointerup = drop;
  canvas.onpointercancel = drop;

  // ---------- 작품 슬라이드 (설정 창의 '작품' 탭) ----------
  /** 올린 작품들을 옆으로 넘겨 보는 띠. 누르면 지금 보고 있는 벽에 걸린다 */
  function drawSlides(): void {
    const box = $("#slides");
    if (!mine.length) {
      box.innerHTML = `<p class="hint">아직 올린 작품이 없습니다. 오른쪽 '작품 올리기' 로 사진을 올려 보세요.</p>`;
      return;
    }
    const list = [...mine];
    if (inGallery()) {   // 전시장은 모든 아이의 작품을 아이별로 묶어 보여 준다
      list.sort((x, y) => kidName(x.kid_id).localeCompare(kidName(y.kid_id), "ko") || x.name.localeCompare(y.name, "ko"));
    }
    let last: string | null = null;
    box.innerHTML = list.map((a) => {
      const who = a.kid_id ?? "";
      const head = inGallery() && who !== last ? `<span class="slide-kid">${esc(kidName(a.kid_id))}</span>` : "";
      last = who;
      const hung = arts.filter((x) => x.image === a.file).length;
      return `${head}<div class="slide" data-file="${esc(a.file)}" title="${esc(a.name)}">
        <img src="/${esc(a.file)}" alt="" loading="lazy" style="background:${bgOf(a)}">
        <span class="s-name">${esc(a.name)}</span>
        ${hung ? `<span class="s-badge">${hung}</span>` : ""}
        <button class="s-edit" data-act="cut">편집</button>
      </div>`;
    }).join("");
    box.querySelectorAll<HTMLElement>("[data-file]").forEach((el) => {
      const a = mine.find((x) => x.file === el.dataset.file);
      if (!a) return;
      el.onclick = (ev) => {
        if ((ev.target as HTMLElement).dataset.act === "cut") void edit(a);
        else void hang(a);
      };
    });
  }

  /** 지금 보고 있는 벽 (둘러보는 중이면 카메라가 향한 벽, TV 화면이면 정면 벽) */
  function facingWall(): WallMount | undefined {
    const room = mounts.filter((x) => x.host === null);
    if (!stage.looking) return room.find((x) => x.id === "back") ?? room[0] ?? mounts[0];
    const ahead = stage.camera.getWorldDirection(new THREE.Vector3());
    return [...room].sort((p, q) => p.normal.dot(ahead) - q.normal.dot(ahead))[0] ?? mounts[0];
  }

  async function hang(a: Artwork): Promise<void> {
    const w = facingWall();
    if (!w) { msg("걸 수 있는 벽이 없습니다", true); return; }
    const art: LayoutArt = {
      id: `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      image: a.file, width: w.defaultSize ?? 0.8, aspect: aspectOf(a), frame: "white",
      mount: { host: w.host, id: w.id }, u: 0, v: 1.5, bg: bgOf(a), pad: padOf(a),
    };
    fit(art, w);
    arts.push(art);
    picked = art.id;
    dirty = true;
    await rebuild();
    drawSlides();
    msg("걸었습니다. 끌어서 옮기고 아래에서 크기를 바꾸세요");
  }

  async function edit(a: Artwork): Promise<void> {
    try {
      if (dirty) await save();                  // 편집하면 서버가 걸린 그림들을 고치므로, 손보던 것을 먼저 저장해 둔다
      await upload.edit(a);
    } catch (e) { msg(String(e), true); }
  }

  async function removeArtwork(a: Artwork): Promise<boolean> {
    if (arts.some((x) => x.image === a.file)) { msg("먼저 벽에서 내려 주세요", true); return false; }
    if (!confirm(`"${a.name}" 사진을 지울까요?`)) return false;
    try {
      await api("POST", "/api/artworks/delete", { file: a.file });
      mine = mine.filter((x) => x.file !== a.file);
      drawSlides();
      msg("지웠습니다");
      return true;
    } catch (e) { msg(String(e), true); }
    return false;
  }

  // ---------- 고른 그림: 크기 · 액자 ----------
  // 높이 막대는 없다: 자리는 끌어서 정하고, 크기는 비율 그대로 벽 안에서만 바뀐다
  const panel = $("#panel");
  const wIn = $<HTMLInputElement>("#w");
  const frameIn = $<HTMLSelectElement>("#frame");
  const presetIn = $<HTMLSelectElement>("#preset");
  const fxIns = [...panel.querySelectorAll<HTMLInputElement>("[data-fx]")];
  const cur = (): LayoutArt | undefined => arts.find((x) => x.id === picked);
  frameIn.innerHTML = FRAME_STYLES.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("");
  presetIn.innerHTML = `<option value="">직접 맞춤</option>`
    + FX_PRESETS.map((x) => `<option value="${x.id}">${x.name}</option>`).join("");

  // ---- 탭 ----
  panel.querySelectorAll<HTMLButtonElement>(".p-tabs button").forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab as Tab; showTab(); };
  });
  function showTab(): void {
    panel.querySelectorAll<HTMLElement>(".p-tabs button").forEach((t) => t.classList.toggle("on", t.dataset.tab === tab));
    panel.querySelectorAll<HTMLElement>(".p-body").forEach((t) => { t.hidden = t.dataset.tab !== tab; });
  }
  showTab();

  /** 고른 그림에 맞춰 설정 창을 맞춘다 (고른 것이 없으면 작품·조명만 쓸 수 있다) */
  function syncPanel(): void {
    const a = cur();
    const name = a ? mine.find((x) => x.file === a.image)?.name ?? "작품" : "";
    $(".who").textContent = name;
    $(".p-head").hidden = !a;                   // 고른 것이 없으면 머리줄은 자리만 차지한다
    $("#down").hidden = !a;
    panel.querySelectorAll<HTMLElement>(".pick-first").forEach((el) => { el.hidden = !!a; });
    [wIn, frameIn, presetIn, ...fxIns].forEach((el) => { el.disabled = !a; });
    if (a) {
      wIn.min = String(MIN_W);
      wIn.max = maxWidth(a, wallOf(a)).toFixed(2);
      wIn.value = String(a.width);
      frameIn.value = a.frame ?? "canvas";
      showFx(fxOf(a.fx));
    }
    showSize();
  }

  // ---- 작품 탭: 크기 · 액자 ----
  const showSize = (): void => {
    const a = cur();
    $("#w-num").textContent = a ? `${a.width.toFixed(2)}×${(a.width * a.aspect).toFixed(2)}m` : "";
  };
  let timer = 0;
  const later = (): void => { clearTimeout(timer); timer = window.setTimeout(() => void rebuild(), 150); };
  const sized = (width: number): void => {
    // 끄는 동안은 3D 그림을 늘렸다 줄였다 보여 주고, 손을 떼면 액자까지 정확히 다시 짓는다
    const a = cur();
    if (!a) return;
    a.width = width;
    fit(a, wallOf(a));                          // 커지면서 벽 밖으로 나가면 안쪽으로 밀어 넣는다
    const g = findArt(a.id);
    const built = g?.userData.artW as number | undefined;
    if (g && built) g.scale.setScalar(a.width / built);
    placeLive(a);                               // (updateMatrix 까지 한다)
    wIn.value = String(a.width);
    showSize();
    dirty = true;
  };
  wIn.oninput = () => sized(Number(wIn.value));
  wIn.onchange = later;
  panel.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((b) => {
    b.onclick = () => { sized((cur()?.width ?? 0) + Number(b.dataset.step)); later(); };
  });
  frameIn.onchange = () => {
    const a = cur();
    if (!a) return;
    a.frame = frameIn.value;
    dirty = true;
    void rebuild();
  };
  $("#up-btn").onclick = () => $<HTMLInputElement>("#file").click();
  $("#down").onclick = () => {
    const a = cur();
    if (!a) return;
    arts = arts.filter((x) => x.id !== a.id);
    picked = null;
    dirty = true;
    void rebuild();
    drawSlides();
  };

  // ---- 필터 · 하이라이트: 막대를 움직이는 대로 그림에 바로 입힌다 (벽에 번지는 빛만 손을 뗀 뒤 다시 짓는다) ----
  function showFx(fx: ArtFx): void {
    fxIns.forEach((el) => {
      const key = el.dataset.fx as keyof ArtFx;
      el.value = String(fx[key]);
      el.parentElement!.querySelector("b")!.textContent = fxText(key, fx[key]);
    });
    presetIn.value = presetOf(fx);
  }
  const setFx = (patch: Partial<ArtFx>, wall: boolean): void => {
    const a = cur();
    if (!a) return;
    const now = { ...fxOf(a.fx), ...patch };
    a.fx = now;
    stage.room.setArtFx(a.id, now);
    showFx(now);
    dirty = true;
    if (wall) later();
  };
  fxIns.forEach((el) => {
    el.oninput = () => {
      const key = el.dataset.fx as keyof ArtFx;
      setFx({ [key]: Number(el.value) }, key.startsWith("glow"));
    };
  });
  presetIn.onchange = () => {
    const preset = FX_PRESETS.find((x) => x.id === presetIn.value);
    if (preset) setFx(preset.fx, false);
  };

  const fxText = (key: keyof ArtFx, v: number): string =>
    key === "s" || key === "glowSize" || key === "sepia" ? `${Math.round(v * 100)}%`
      : key === "glow" ? (v <= 0 ? "끔" : `${Math.round(v * 100)}%`)
        : key === "glowTone" ? (v < 0.34 ? "따뜻하게" : v < 0.67 ? "중간" : "차갑게")
          : `${v > 0 ? "+" : ""}${Math.round(v * 100)}`;

  /** 지금 값과 똑같은 '골라 쓰기' 가 있으면 그 id (없으면 직접 맞춤) */
  const presetOf = (fx: ArtFx): string =>
    FX_PRESETS.find((x) => (Object.keys(x.fx) as (keyof ArtFx)[]).every((k) => Math.abs((x.fx[k] ?? 0) - fx[k]) < 0.005))?.id ?? "";

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

  // ---------- 조명 탭: 방 전체 밝기 ----------
  const showLight = (): void => { $("#light-num").textContent = `${Math.round(light * 100)}%`; };
  lightIn.oninput = () => {
    light = Number(lightIn.value);
    stage.setLight(light);                      // 바로 보여 준다 (저장해야 TV 에도 반영된다)
    showLight();
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
  kidSel.onchange = () => {
    if (dirty && !confirm("저장하지 않은 것이 있습니다. 옮길까요?")) { kidSel.value = curKid; return; }
    curKid = kidSel.value;
    hall = 1;
    void loadKid();
  };
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  const upload = mountCrop(() => (inGallery() ? upKid.value : kidSel.value), async (entry, replaced) => {
    // 편집한 작품이면 걸려 있던 곳은 서버가 이미 새 모습으로 고쳤다 (모든 실). 이 실을 다시 읽는다
    if (replaced) await loadKid();
    else mine = [entry, ...mine.filter((a) => a.file !== entry.file)];
    drawSlides();
    msg(`"${entry.name}" ${replaced ? "편집했습니다" : "올렸습니다"}`);
  }, msg, removeArtwork);

  await loadKid();
}

/** 여백까지 넣은 세로/가로 비율 */
function aspectOf(a: Artwork): number {
  const size = lookSize(a.width, a.height, a);
  return size.h / size.w;
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
  header { position:fixed; z-index:3; top:0; left:0; right:0; display:flex; flex-direction:column; gap:8px;
           padding:10px 14px 16px; background:linear-gradient(#0e0b16ee,#0e0b1600) }
  header .bar { display:flex; gap:10px; align-items:center; flex-wrap:wrap }
  header h1 { font-size:16px; margin:0 4px 0 0 }
  #msg { font-size:14px; color:#e6ded6 }
  /* 아래 설정 창: 작품 · 필터 · 하이라이트 · 조명. 바꾸는 대로 벽에서 바로 보이도록 낮게 둔다 */
  #panel { position:fixed; z-index:3; left:12px; right:12px; bottom:12px; display:flex; flex-direction:column; gap:8px;
           padding:10px 14px 12px; border-radius:14px; background:#1b1724f2; border:1px solid #3a3346;
           box-shadow:0 10px 30px rgba(0,0,0,.45) }
  #panel label { display:flex; gap:6px; align-items:center; white-space:nowrap }
  #panel .grow { flex:1 1 200px }
  #panel input[type=range] { flex:1; min-width:96px; accent-color:#e9557d }
  #panel input:disabled, #panel select:disabled { opacity:.4 }
  #panel .who { color:#f0b9c8 }
  #panel button[data-step] { padding:2px 10px }
  #panel .p-head { display:flex; gap:10px; align-items:center; min-height:26px }
  #panel .p-tabs { display:flex; gap:6px; flex-wrap:wrap }
  #panel .p-tabs button { padding:6px 16px }
  #panel .p-body { display:flex; gap:16px; align-items:center; flex-wrap:wrap; min-height:34px }
  #panel .p-body.col { flex-direction:column; align-items:stretch; gap:8px }
  #panel .p-body[hidden] { display:none }
  #panel .p-body.warm input[type=range] { accent-color:#ffd166 }
  #panel .p-body b { min-width:3.4em }
  #panel .p-body .hint { color:#9d94a8; margin:0 }
  /* 작품 슬라이드: 옆으로 넘겨 고른다 (누르면 보고 있는 벽에 걸린다) */
  #slides { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; min-height:104px; align-items:stretch }
  #slides .hint { align-self:center }
  .slide { position:relative; flex:0 0 auto; width:102px; padding:4px; border:1px solid #3a3346; border-radius:10px;
           background:#241f2b; cursor:pointer }
  .slide:hover { border-color:#e9557d }
  .slide img { width:100%; height:62px; object-fit:contain; border-radius:6px; display:block }
  .slide .s-name { display:block; margin-top:3px; font-size:11px; color:#c9bfd0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
  .slide .s-badge { position:absolute; top:3px; left:3px; padding:0 6px; border-radius:8px; background:#e9557d; color:#fff; font-size:10px }
  .slide .s-edit { position:absolute; top:3px; right:3px; padding:1px 6px; font-size:11px; background:#1b1724dd }
  .slide-kid { flex:0 0 auto; align-self:stretch; display:flex; align-items:center; padding:0 6px; font-size:12px;
               color:#f0b9c8; border-left:1px solid #3a3346; writing-mode:vertical-rl }
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
  details.group { border:1px solid #e3ded8; border-radius:10px; padding:6px 8px; margin-bottom:8px; background:#fff }
  details.group summary { cursor:pointer; padding:4px 2px }
  details.group summary small { color:#8b8279 }
  details.group .card { margin:8px 0 0 }
  .lamp { display:flex; gap:6px; align-items:center }
  .lamp input { width:110px; accent-color:#ffd166 }
  #share-url { width:100%; box-sizing:border-box; padding:8px; border:1px solid #cdc6bd; border-radius:8px; background:#fff; color:#241f2b }
${CROP_CSS}
</style>
<div id="view"></div>
<header>
  <div class="bar">
    <h1>전시실</h1>
    <select id="kid"></select>
    <button id="open-share">공유</button>
    <span class="grow"></span>
    <span id="msg"></span>
    <button id="save" class="on">저장</button>
  </div>
  <div class="bar" id="hall-row"><span id="halls"></span></div>
</header>
<input id="file" type="file" accept="image/*" capture="environment" style="display:none">
<div id="panel">
  <div class="p-head" hidden><b class="who"></b><span class="grow"></span><button id="down" class="ghost" hidden>벽에서 내리기</button></div>
  <div class="p-tabs">
    <button data-tab="art" class="on">작품</button>
    <button data-tab="fx">필터</button>
    <button data-tab="glow">하이라이트</button>
    <button data-tab="light">조명</button>
  </div>
  <div class="p-body col" data-tab="art">
    <div id="slides"></div>
    <div class="row wrap">
      <label class="grow">크기 <button data-step="-0.05">−</button>
        <input id="w" type="range" min="0.15" max="3" step="0.01" value="1">
        <button data-step="0.05">＋</button> <b id="w-num"></b></label>
      <label>액자 <select id="frame"></select></label>
      <button id="up-btn" class="on">작품 올리기</button>
      <label id="up-who" hidden>올릴 아이 <select id="up-kid"></select></label>
    </div>
  </div>
  <div class="p-body warm" data-tab="fx" hidden>
    <label>골라 쓰기 <select id="preset"></select></label>
    <label class="grow">밝기 <input data-fx="b" type="range" min="-1" max="1" step="0.01" value="0"> <b></b></label>
    <label class="grow">대비 <input data-fx="c" type="range" min="-1" max="1" step="0.01" value="0"> <b></b></label>
    <label class="grow">채도 <input data-fx="s" type="range" min="0" max="2" step="0.01" value="1"> <b></b></label>
    <label class="grow">색온도 <input data-fx="w" type="range" min="-1" max="1" step="0.01" value="0"> <b></b></label>
    <label class="grow">세피아 <input data-fx="sepia" type="range" min="0" max="1" step="0.01" value="0"> <b></b></label>
    <span class="hint pick-first">먼저 걸린 작품을 누르세요.</span>
  </div>
  <div class="p-body warm" data-tab="glow" hidden>
    <label class="grow">세기 <input data-fx="glow" type="range" min="0" max="2" step="0.01" value="0"> <b></b></label>
    <label class="grow">번짐 <input data-fx="glowSize" type="range" min="0.4" max="2" step="0.01" value="1"> <b></b></label>
    <label class="grow">빛 색 <input data-fx="glowTone" type="range" min="0" max="1" step="0.01" value="0.35"> <b></b></label>
    <span class="hint pick-first">먼저 걸린 작품을 누르세요.</span>
    <span class="hint">작품만 환하게 비춰 줍니다 (방 밝기를 낮춰도 이 작품은 그대로).</span>
  </div>
  <div class="p-body warm" data-tab="light" hidden>
    <label class="grow">방 밝기 <input id="light" type="range" min="0.2" max="1.6" step="0.02" value="1"> <b id="light-num"></b></label>
    <span class="hint">이 전시실 전체가 밝아지고 어두워집니다. 저장해야 TV 에도 그대로 나옵니다.</span>
  </div>
</div>
<div id="share" class="modal">
  <div class="box">
    <div class="row"><h2>부모님께 보낼 주소</h2><span class="grow"></span><button id="share-close" class="ghost">닫기</button></div>
    <input id="share-url" readonly>
    <p class="hint">이 주소로 들어오면 로그인 없이 전시실을 볼 수 있습니다. 꾸미기는 안 되고, 작품을 누르면 크게 보고 내려받을 수 있어요.</p>
    <p class="hint">사진을 올리면 AI 가 배경을 지워 줍니다. 여백과 배경색은 작품의 '편집' 에서 언제든 바꿀 수 있어요.</p>
    <div class="row"><span class="hint" id="share-note"></span><span class="grow"></span><button id="share-copy" class="on">주소 복사</button></div>
  </div>
</div>
${CROP_HTML}`;
