import * as THREE from "three";
import { Stage, fetchCatalog } from "../tv/stage";
import type { WallMount } from "../world/room";
import { renderNow, type Layout, type LayoutArt, type WorldRender } from "../world/types";
import { bgOf, lookSize, padOf } from "../world/artimage";
import { fxOf, type ArtFx } from "../world/artfx";
import { LookAround } from "../world/lookaround";
import { CROP_CSS, CROP_HTML, mountCrop, type Artwork } from "./crop";

/**
 * 아이 전시실 꾸미기 (?mode=art).
 *
  * **방 안에 서서 보면서 건다** (2026-09-21): 벽을 하나씩 골라 평면으로 보던 것을 접고, 쓸어 넘겨 둘러보는 3D 방에서
 * 그림을 끌어 옮긴다 (world/lookaround.ts). 배경은 같은 자리에서 구운 360° 파노라마라 어느 벽이든 렌더 품질 그대로다.
 *   - 아래 설정 창은 세 탭: **작품**(슬라이드로 걸고 내리기·사진 올리기) · **핀 조명**(고른 작품만) · **배치**(크기·방 밝기)
 *   - 여백·배경·액자·필터·설명은 **작품 편집 창**에서 정한다 (crop.ts). 크기까지 작품에 붙어서 걸린 곳이 모두 따라 바뀐다
 *   - 끄는 동안 다른 벽으로 넘어가면 그 벽으로 옮겨 걸린다. 벽을 넘는 크기는 화면에서 줄여 건다
 *   - 작품 편집(AI 배경 지우기 · 여백 · 배경색 · 지우기)은 crop.ts. 이미 올린 작품도 다시 편집할 수 있다
 *   - 한 작품은 한 전시실에 하나만 걸린다. 썸네일을 누르면 걸리고, 걸린 것을 다시 누르면 내려온다
 *   - 썸네일 위 **핀**으로 고정하면 끌어서 옮기거나 잘못 내려지지 않는다 (LayoutArt.pin)
 *   - 액자·여백·배경색·설명은 **작품에 붙는다** (편집 창에서 고치면 걸려 있는 곳이 모두 따라 바뀐다). 필터·하이라이트는 걸린 그림마다
 *   - **전시장**(모두가 같이 쓰는 방)도 여기서 꾸민다: 가구는 없고 작품만 건다. 슬라이드는 모든 아이 것을 아이별로 묶어 보여 준다
 *   - 전시실은 1실·2실·3실… 로 늘릴 수 있고(kid-<id>@2), 실마다 조명 밝기를 따로 둔다
 *   - 공유: 부모님께 보낼 주소를 복사한다 (/?mode=gallery&k=열쇠, 보기 전용 — gallery/index.ts).
 *     같은 창의 **내보내기**는 전시실을 .html 한 장으로 받는다 (서버 없이 폰에서 열린다 — server/ribbon/gallery_export.py)
 * 저장하면 그 아이 전시실(kid-<아이 id>)의 arts 만 바뀐다. 배경은 모든 아이가 같은 렌더(kidbase)를 쓰므로
 * 다시 렌더할 필요가 없고, TV 가 그 배경 위에 그림만 실시간으로 그린다.
 */

interface Kid { id: string; name: string }

type Tab = "art" | "glow" | "place";
/** 썸네일 위에 얹는 핀 (그림 글자가 아니라 작은 그림) */
const PIN = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
  <path d="M14.5 2.5 21.5 9.5l-2 2-1.5-.5-4 4 .5 3-2 2-4-4-5 5 5-5-4-4 2-2 3 .5 4-4-.5-1.5z" fill="currentColor"/></svg>`;
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
  // 사진 올리기: 슬라이드 왼쪽에 붙박이로 둔다 (넘겨 봐도 늘 보이게). 폰에서 '신규' 는 카메라, '갤러리' 는 사진첩
  const fileIn = $<HTMLInputElement>("#file");
  $("#up-new").onclick = () => { fileIn.setAttribute("capture", "environment"); fileIn.click(); };
  $("#up-pick").onclick = () => { fileIn.removeAttribute("capture"); fileIn.click(); };

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
    $("#up-row").hidden = !gallery;
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
    if (a.pin) { msg("고정된 작품입니다. 핀을 풀면 옮길 수 있어요"); return; }
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
      box.innerHTML = `<p class="hint">아직 올린 작품이 없습니다. 왼쪽 '신규' 로 찍거나 '앨범' 에서 고르세요.</p>`;
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
      const hung = arts.find((x) => x.image === a.file);          // 한 전시실에 하나만 건다
      return `${head}<div class="slide${hung ? " hung" : ""}" data-file="${esc(a.file)}" title="${esc(a.name)}">
        <img src="/${esc(a.file)}" alt="" loading="lazy" style="background:${bgOf(a)}">
        ${hung ? `<button class="s-pin${hung.pin ? " on" : ""}" data-act="pin"
          title="${hung.pin ? "고정 풀기" : "여기 고정하기"}">${PIN}</button>` : ""}
        <div class="s-btns">
          <button data-act="cut">편집</button>
          <button data-act="del" class="ghost">삭제</button>
        </div>
      </div>`;
    }).join("");
    bindSlides();
  }

  function bindSlides(): void {
    const box = $("#slides");
    box.querySelectorAll<HTMLElement>("[data-file]").forEach((el) => {
      const a = mine.find((x) => x.file === el.dataset.file);
      if (!a) return;
      el.onclick = (ev) => {
        const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "pin") togglePin(a.file);
        else if (act === "cut") void edit(a);
        else if (act === "del") void removeArtwork(a);
        else if (arts.some((x) => x.image === a.file)) takeDown(a.file);   // 걸린 것을 다시 누르면 내린다
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

  /** 고정: 끌어서 옮기거나 잘못 내려지지 않게 (썸네일 위 핀) */
  function togglePin(file: string): void {
    const a = arts.find((x) => x.image === file);
    if (!a) return;
    a.pin = !a.pin;
    dirty = true;
    drawSlides();
    msg(a.pin ? "고정했습니다" : "고정을 풀었습니다");
  }

  /** 벽에서 내린다 (걸린 썸네일을 다시 누를 때) */
  function takeDown(file: string): void {
    if (arts.find((x) => x.image === file)?.pin) { msg("고정된 작품입니다. 핀을 풀고 내려 주세요", true); return; }
    arts = arts.filter((x) => x.image !== file);
    picked = null;
    dirty = true;
    void rebuild();
    drawSlides();
    msg("내렸습니다");
  }

  async function hang(a: Artwork): Promise<void> {
    const w = facingWall();
    if (!w) { msg("걸 수 있는 벽이 없습니다", true); return; }
    const art: LayoutArt = {
      id: `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      image: a.file, width: a.size ?? w.defaultSize ?? 0.8, aspect: aspectOf(a), frame: a.frame ?? "white",
      mount: { host: w.host, id: w.id }, u: 0, v: 1.5, bg: bgOf(a), pad: padOf(a), fx: { ...fxOf(a.fx) },
    };
    fit(art, w);
    arts.push(art);
    picked = art.id;
    dirty = true;
    await rebuild();
    drawSlides();
    msg("걸었습니다. 끌어서 옮기고 아래 막대로 크기를 바꾸세요");
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
  const fxIns = [...panel.querySelectorAll<HTMLInputElement>("[data-fx]")];
  const wIn = $<HTMLInputElement>("#w");
  const cur = (): LayoutArt | undefined => arts.find((x) => x.id === picked);

  // ---- 탭 ----
  panel.querySelectorAll<HTMLButtonElement>(".p-tabs button").forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab as Tab; showTab(); };
  });
  function showTab(): void {
    // 핀 조명은 걸린 작품을 골랐을 때만 (고른 것이 없으면 작품·조명만)
    if (tab === "glow" && !cur()) tab = "art";
    panel.querySelectorAll<HTMLElement>(".p-tabs button").forEach((t) => {
      t.classList.toggle("on", t.dataset.tab === tab);
      if (t.dataset.tab === "glow") t.hidden = !cur();
    });
    panel.querySelectorAll<HTMLElement>(".p-body").forEach((t) => { t.hidden = t.dataset.tab !== tab; });
  }
  showTab();

  /** 고른 그림에 맞춰 설정 창을 맞춘다 (고른 것이 없으면 작품·조명만 쓸 수 있다) */
  function syncPanel(): void {
    const a = cur();
    wIn.disabled = !a;
    if (a) {
      wIn.min = String(MIN_W);
      wIn.max = maxWidth(a, wallOf(a)).toFixed(2);
      wIn.value = String(a.width);
      showFx(fxOf(a.fx));
    }
    showTab();
  }

  // ---- 배치 탭: 크기 (작품에 붙는 값이라 걸린 곳이 모두 따라 바뀐다) ----
  let sizeSave = 0;
  const sized = (width: number): void => {
    const a = cur();
    if (!a) return;
    a.width = width;
    fit(a, wallOf(a));                          // 벽 밖으로 나가면 안쪽으로 밀어 넣는다
    const g = findArt(a.id);
    const built = g?.userData.artW as number | undefined;
    if (g && built) g.scale.setScalar(a.width / built);
    placeLive(a);
    wIn.value = String(a.width);
    dirty = true;
    later();
    clearTimeout(sizeSave);                     // 손을 뗀 뒤 작품에도 적어 둔다 (다음에 걸 때도 이 크기로)
    sizeSave = window.setTimeout(() => {
      const art = mine.find((x) => x.file === a.image);
      if (!art) return;
      art.size = a.width;
      void api("PUT", "/api/artworks/meta", { file: a.image, size: a.width }).catch(() => undefined);
    }, 600);
  };
  wIn.oninput = () => sized(Number(wIn.value));
  panel.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((b) => {
    b.onclick = () => sized((cur()?.width ?? 0) + Number(b.dataset.step));
  });

  let timer = 0;
  const later = (): void => { clearTimeout(timer); timer = window.setTimeout(() => void rebuild(), 150); };

  // ---- 핀 조명: 막대를 움직이는 대로 그림에 바로 입힌다 (벽에 번지는 빛만 손을 뗀 뒤 다시 짓는다) ----
  function showFx(fx: ArtFx): void {
    fxIns.forEach((el) => {
      const key = el.dataset.fx as keyof ArtFx;
      el.value = String(fx[key]);
      el.parentElement!.querySelector("b")!.textContent = fxText(key, fx[key]);
    });
  }
  fxIns.forEach((el) => {
    el.oninput = () => {
      const a = cur();
      if (!a) return;
      const now = { ...fxOf(a.fx), [el.dataset.fx as keyof ArtFx]: Number(el.value) };
      a.fx = now;
      stage.room.setArtFx(a.id, now);
      showFx(now);
      dirty = true;
      later();                                  // 벽에 번지는 빛은 손을 뗀 뒤 다시 짓는다
    };
  });

  const fxText = (key: keyof ArtFx, v: number): string =>
    key === "glowSize" ? `${Math.round(v * 100)}%`
      : key === "glow" ? (v <= 0 ? "끔" : `${Math.round(v * 100)}%`)
        : v < 0.34 ? "따뜻하게" : v < 0.67 ? "중간" : "차갑게";

  // ---------- 전시실 1실 · 2실 · 3실 ----------
  function drawHalls(): void {
    const box = $("#halls");
    box.innerHTML = Array.from({ length: halls }, (_, i) =>
      `<button data-hall="${i + 1}" class="${i + 1 === hall ? "on" : ""}">${i + 1}실${
        i + 1 === hall && halls > 1 ? `<span class="x" data-act="del" title="이 전시실 없애기">✕</span>` : ""}</button>`).join("")
      + `<button data-act="add" class="step" title="전시실 늘리기">+</button>`;
    box.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.onclick = (ev) => {
        if (b.dataset.act === "add") { void setHalls(halls + 1); return; }
        if ((ev.target as HTMLElement).dataset.act === "del") { void dropHall(Number(b.dataset.hall)); return; }
        void goHall(Number(b.dataset.hall));
      };
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
    try {
      if (dirty) await save();
      const r = await api<{ halls: number }>("PUT", `/api/kids/${encodeURIComponent(kidSel.value)}/halls`, { count });
      if (r.halls === halls) { msg("전시실은 더 늘릴 수 없습니다", true); return; }
      hall = r.halls;                           // 새로 만든 방으로 간다
      await loadKid();
      msg(`${r.halls}실을 만들었습니다`);
    } catch (e) { msg(String(e), true); }
  }

  /** 고른 실 하나를 없앤다 (뒤 실들이 한 칸씩 당겨진다) */
  async function dropHall(n: number): Promise<void> {
    if (!confirm(`${n}실을 없앨까요? 그 방에 걸어 둔 그림은 벽에서 내려집니다 (사진은 남아요).`)) return;
    try {
      if (dirty) await save();
      const r = await api<{ halls: number }>("DELETE", `/api/kids/${encodeURIComponent(kidSel.value)}/halls/${n}`);
      hall = Math.min(hall, r.halls);
      await loadKid();
      msg("없앴습니다");
    } catch (e) { msg(String(e), true); }
  }

  // ---------- 설정 창 접기·펴기 (손잡이를 끌거나 누른다) ----------
  const handle = $(".p-grab");
  const openPanel = (on: boolean): void => { panel.classList.toggle("shut", !on); };
  let handleY: number | null = null;
  handle.onpointerdown = (ev) => {
    handleY = ev.clientY;
    handle.setPointerCapture(ev.pointerId);
  };
  handle.onpointerup = (ev) => {
    if (handleY === null) return;
    const dy = ev.clientY - handleY;
    handleY = null;
    if (Math.abs(dy) < 12) openPanel(panel.classList.contains("shut"));   // 살짝 눌렀다: 그냥 뒤집기
    else openPanel(dy < 0);                                              // 위로 끌면 펴고, 아래로 끌면 접는다
  };
  handle.onpointercancel = () => { handleY = null; };

  // ---------- 조명 탭: 방 전체 밝기 ----------
  const showLight = (): void => { $("#light-num").textContent = `${Math.round(light * 100)}%`; };
  panel.querySelectorAll<HTMLButtonElement>("[data-light]").forEach((b) => {
    b.onclick = () => {
      lightIn.value = String(Math.min(1.6, Math.max(0.2, light + Number(b.dataset.light))));
      lightIn.dispatchEvent(new Event("input"));
    };
  });
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
  $("#share-export").onclick = async () => {
    const btn = $<HTMLButtonElement>("#share-export");
    btn.disabled = true;
    $("#export-note").textContent = "전시실을 파일로 묶는 중…";
    try {
      const res = await fetch(`/api/kids/${encodeURIComponent(kidSel.value)}/export`);
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `${res.status}`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${kidName(kidSel.value)}_전시실.html`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      $("#export-note").textContent = `받았습니다 (${(blob.size / 1024 / 1024).toFixed(1)}MB)`;
    } catch (e) {
      $("#export-note").textContent = String(e);
    } finally { btn.disabled = false; }
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
  }, msg);

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
  /* 단추·드롭박스 높이를 맞추고 빈틈을 줄인다 */
  select, input, button { font:inherit; font-size:14px }
  select, button { height:30px; padding:0 10px; border:1px solid #4a4356; border-radius:8px;
                   background:#241f2b; color:#f3efe9; box-sizing:border-box }
  button { cursor:pointer }
  .step { display:inline-flex; align-items:center; justify-content:center; width:30px; padding:0; line-height:1 }
  button.on { background:#e9557d; border-color:#e9557d; color:#fff }
  button.ghost { color:#c9b7bd }
  button:hover { border-color:#e9557d }
  header { position:fixed; z-index:3; top:0; left:0; right:0; display:flex; flex-direction:column; gap:6px;
           padding:8px 12px 14px; background:linear-gradient(#0e0b16ee,#0e0b1600) }
  header .bar { display:flex; gap:6px; align-items:center; flex-wrap:wrap }
  header h1 { font-size:15px; margin:0 4px 0 0 }
  #msg { font-size:14px; color:#e6ded6 }
  /* 아래 설정 창: 작품 · 필터 · 하이라이트 · 조명. 바꾸는 대로 벽에서 바로 보이도록 낮게 둔다 */
  #panel { position:fixed; z-index:3; left:12px; right:12px; bottom:12px; display:flex; flex-direction:column; gap:6px;
           padding:8px 12px 10px; border-radius:14px; background:#1b1724f2; border:1px solid #3a3346;
           box-shadow:0 10px 30px rgba(0,0,0,.45) }
  #panel label { display:flex; gap:6px; align-items:center; white-space:nowrap }
  #panel .grow { flex:1 1 200px }
  #panel input[type=range] { flex:1; min-width:96px; accent-color:#e9557d }
  #panel input:disabled, #panel select:disabled { opacity:.4 }
  /* 손잡이를 끌어(또는 눌러) 접었다 편다 */
  #panel .p-grab { display:flex; align-items:center; justify-content:center; height:16px; margin:-6px 0 0; cursor:grab; touch-action:none }
  #panel .p-grab span { width:44px; height:4px; border-radius:2px; background:#5b5268 }
  #panel .p-grab:hover span { background:#e9557d }
  #panel.shut { gap:0 }
  #panel.shut .p-tabs, #panel.shut .p-body { display:none }
  #panel .p-tabs { display:flex; gap:4px; flex-wrap:wrap }
  #panel .p-tabs button { padding:0 16px }
  #panel .p-body { display:flex; gap:14px; align-items:center; flex-wrap:wrap; min-height:30px }
  #panel .p-body.col { flex-direction:column; align-items:stretch; flex-wrap:nowrap; gap:6px }
  #panel .p-body[hidden] { display:none }
  #panel .p-body.warm input[type=range], #panel .warm input[type=range] { accent-color:#ffd166 }
  #panel .p-body b { min-width:3.4em }
  #panel .p-body .hint { color:#9d94a8; margin:0 }
  /* 작품 슬라이드: 옆으로 넘겨 고른다 (누르면 보고 있는 벽에 걸린다) */
  /* 사진 올리기는 왼쪽에 붙박이, 작품만 옆으로 넘어간다 */
  .slide-row { display:flex; gap:8px; align-items:stretch; min-width:0; min-height:93px }   /* 안쪽 띠만 넘어가게 */
  .up-box { flex:0 0 auto; display:flex; flex-direction:column; justify-content:center; gap:4px; width:56px }
  .up-box button { height:27px; padding:0; font-size:13px }
  .up-box button:first-child { background:#e9557d; border-color:#e9557d; color:#fff }
  #slides { flex:1; min-width:0; display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; align-items:stretch }
  /* 썸네일(누르면 걸고, 걸린 것을 다시 누르면 내린다)과 아래 단추를 줄로 나눠 둔다 */
  .slide { position:relative; flex:0 0 auto; width:112px; padding:0; overflow:hidden; border:1px solid #3a3346;
           border-radius:10px; background:#241f2b; cursor:pointer }
  .slide:hover { border-color:#e9557d }
  .slide.hung { border-color:#e9557d; box-shadow:inset 0 0 0 2px #e9557d55 }
  .slide img { width:100%; height:66px; object-fit:contain; display:block; background:#fff }
  .slide .s-pin { position:absolute; top:3px; right:3px; display:flex; align-items:center; justify-content:center;
                  width:22px; height:22px; padding:0; border-radius:50%; border:0; color:#fff; background:#1b1724aa }
  .slide .s-pin svg { pointer-events:none }
  .slide .s-pin:hover { background:#1b1724e6 }
  .slide .s-pin.on { background:#e9557d }
  .slide .s-btns { display:flex; border-top:1px solid #3a3346 }
  .slide .s-btns button { flex:1; height:24px; padding:0; border:0; border-radius:0; font-size:11px; background:#1b1724 }
  .slide .s-btns button + button { border-left:1px solid #3a3346 }
  .slide .s-btns button:hover { background:#2f2838; color:#ffb3c8 }
  .slide-kid { flex:0 0 auto; align-self:stretch; display:flex; align-items:center; padding:0 4px; font-size:12px;
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
  #halls button { display:flex; align-items:center; gap:6px }
  #halls .x { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; margin-right:-4px;
              border-radius:50%; background:#ffffff2e; font-size:11px }
  #halls .x:hover { background:#fff; color:#e9557d }
  details.group { border:1px solid #e3ded8; border-radius:10px; padding:6px 8px; margin-bottom:8px; background:#fff }
  details.group summary { cursor:pointer; padding:4px 2px }
  details.group summary small { color:#8b8279 }
  details.group .card { margin:8px 0 0 }
  .lamp { display:flex; gap:6px; align-items:center }
  .lamp input { width:110px; accent-color:#ffd166 }
  .modal hr { width:100%; border:0; border-top:1px solid #e3ded8; margin:2px 0 }
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
  <div class="p-grab" title="끌어서 접기·펴기"><span></span></div>
  <div class="p-tabs">
    <button data-tab="art" class="on">작품</button>
    <button data-tab="glow" hidden>핀 조명</button>
    <button data-tab="place">배치</button>
  </div>
  <div class="p-body col" data-tab="art">
    <div class="slide-row">
      <div class="up-box">
        <button id="up-new">신규</button>
        <button id="up-pick">앨범</button>
      </div>
      <div id="slides"></div>
    </div>
    <div class="row wrap" id="up-row" hidden>
      <span class="grow"></span>
      <label id="up-who">올릴 아이 <select id="up-kid"></select></label>
    </div>
  </div>
  <div class="p-body warm" data-tab="glow" hidden>
    <label class="grow">세기 <input data-fx="glow" type="range" min="0" max="2" step="0.01" value="0"> <b></b></label>
    <label class="grow">번짐 <input data-fx="glowSize" type="range" min="0.4" max="2" step="0.01" value="1"> <b></b></label>
    <label class="grow">빛 색 <input data-fx="glowTone" type="range" min="0" max="1" step="0.01" value="0.35"> <b></b></label>
  </div>
  <div class="p-body" data-tab="place" hidden>
    <label class="grow">크기 <button data-step="-0.05" class="step">−</button>
      <input id="w" type="range" min="0.15" max="3" step="0.01" value="1">
      <button data-step="0.05" class="step">+</button></label>
    <label class="grow warm">방 밝기 <button data-light="-0.05" class="step">−</button>
      <input id="light" type="range" min="0.2" max="1.6" step="0.02" value="1">
      <button data-light="0.05" class="step">+</button> <b id="light-num"></b></label>
  </div>
</div>
<div id="share" class="modal">
  <div class="box">
    <div class="row"><h2>부모님께 보낼 주소</h2><span class="grow"></span><button id="share-close" class="ghost">닫기</button></div>
    <input id="share-url" readonly>
    <p class="hint">이 주소로 들어오면 로그인 없이 전시실을 볼 수 있습니다. 꾸미기는 안 되고, 작품을 누르면 크게 보고 내려받을 수 있어요.</p>
    <p class="hint">사진을 올리면 AI 가 배경을 지워 줍니다. 여백과 배경색은 작품의 '편집' 에서 언제든 바꿀 수 있어요.</p>
    <div class="row"><span class="hint" id="share-note"></span><span class="grow"></span><button id="share-copy" class="on">주소 복사</button></div>
    <hr>
    <h2>파일로 주기</h2>
    <p class="hint">전시실을 <b>.html 파일 한 장</b>으로 받습니다. 인터넷이나 서버 없이 폰·컴퓨터에서 바로 열리고,
      걸린 작품과 아직 걸지 않은 작품까지 모두 들어갑니다. 학원을 그만두는 아이에게 통째로 주기 좋아요 (그림 수에 따라 몇 MB ~ 수십 MB).</p>
    <div class="row"><span class="hint" id="export-note"></span><span class="grow"></span><button id="share-export">내보내기</button></div>
  </div>
</div>
${CROP_HTML}`;
