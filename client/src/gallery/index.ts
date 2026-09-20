import * as THREE from "three";
import { Stage, fetchCatalog } from "../tv/stage";
import { bgOf, composeArt } from "../world/artimage";
import { renderNow, type Layout, type WorldRender } from "../world/types";

/**
 * 부모님께 보내는 전시실 (?mode=gallery&k=<열쇠>). **보기 전용**이고 로그인하지 않는다.
 *
 * 전시실 꾸미기(?mode=art)의 🔗 공유에서 복사한 주소로 들어온다. 열쇠가 맞으면 서버(GET /api/share/<열쇠>)가
 * 그 아이의 전시실들(1실·2실…)과 걸린 작품을 준다. TV 와 같은 3D 방을 보여 주고(왼쪽·오른쪽 벽도 정면으로 돌려 본다),
 * 작품을 누르면(방 안의 그림이든 아래 작은 그림이든) 올린 그대로의 크기로 크게 보고 내려받을 수 있다.
 * 내려받기는 두 가지: **배경 없는 원본**(올린 파일 그대로) / **배경색을 골라서**(여백까지 합친 그림, world/artimage.ts).
 */
interface Artwork { file: string; name: string; width: number; height: number; bg?: string; pad?: number[] }
interface Hall { room: string; layout: Layout | null; render: WorldRender | null }
interface Shared { name: string; halls: Hall[]; artworks: Artwork[] }

export async function startGallery(): Promise<void> {
  document.body.innerHTML = PAGE;
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
  const key = new URLSearchParams(location.search).get("k") ?? "";
  const res = await fetch(`/api/share/${encodeURIComponent(key)}`).catch(() => null);
  if (!res?.ok) {
    $("#title").textContent = "전시실을 찾지 못했어요";
    $("#note").textContent = "주소가 바뀌었을 수 있습니다. 학원에 다시 물어봐 주세요.";
    return;
  }
  const data = await res.json() as Shared;
  document.title = `${data.name}의 전시실`;
  $("#title").textContent = `🖼 ${data.name}의 전시실`;

  const stage = new Stage($("#view"), await fetchCatalog());
  const loop = (): void => { requestAnimationFrame(loop); stage.render(); };
  requestAnimationFrame(loop);
  let hall = 0;
  let facing = "";                         // 정면에서 보고 있는 벽. 비어 있으면 TV 와 같은 화면

  async function show(n: number): Promise<void> {
    hall = n;
    const h = data.halls[n];
    // 벽을 정면에서 볼 때는 렌더 없이 실시간 3D 로 (배경 렌더는 한 방향에서 찍은 한 장뿐이다)
    await stage.setWorld(h.room, h.layout, facing ? null : renderNow(h.render));
    const wallsOnly = stage.room.wallMounts().filter((w) => w.host === null);
    stage.faceWall(wallsOnly.find((w) => w.key === facing) ?? null);
    const views = $("#views");
    views.innerHTML = `<button data-view="" class="${facing ? "" : "on"}">전체</button>`
      + wallsOnly.map((w) => `<button data-view="${esc(w.key)}" class="${w.key === facing ? "on" : ""}">${esc(w.name)}</button>`).join("");
    views.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.onclick = () => { facing = b.dataset.view ?? ""; void show(hall); };
    });
    const tabs = $("#halls");
    tabs.innerHTML = data.halls.length > 1
      ? data.halls.map((_, i) => `<button data-hall="${i}" class="${i === n ? "on" : ""}">${i + 1}실</button>`).join("") : "";
    tabs.querySelectorAll<HTMLButtonElement>("button").forEach((b) => { b.onclick = () => void show(Number(b.dataset.hall)); });
    // 아래 작은 그림들: 이 방에 걸린 순서대로 (폰에서는 방 안의 그림이 작아 누르기 어렵다)
    const files = [...new Set((h.layout?.arts ?? []).map((a) => a.image))];
    const strip = $("#strip");
    strip.innerHTML = files.map((f) => `<img src="/${esc(f)}" data-file="${esc(f)}" alt="" loading="lazy"
      style="background:${bgOf(data.artworks.find((x) => x.file === f))}">`).join("");
    strip.querySelectorAll<HTMLImageElement>("img").forEach((img) => { img.onclick = () => open(img.dataset.file!); });
    $("#note").textContent = files.length ? "작품을 누르면 크게 볼 수 있어요" : "아직 걸린 작품이 없어요";
  }

  // ---------- 방 안의 그림 누르기 ----------
  const canvas = stage.renderer.domElement;
  const ray = new THREE.Raycaster();
  const artAt = (ev: PointerEvent | MouseEvent): string | null => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1,
                                        -((ev.clientY - r.top) / r.height) * 2 + 1), stage.camera);
    for (const hit of ray.intersectObject(stage.room.group, true)) {
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
        const id = o.userData.art as string | undefined;
        if (id) return data.halls[hall].layout?.arts?.find((a) => a.id === id)?.image ?? null;
      }
    }
    return null;
  };
  canvas.onclick = (ev) => { const f = artAt(ev); if (f) open(f); };
  canvas.onpointermove = (ev) => { canvas.style.cursor = artAt(ev) ? "zoom-in" : ""; };

  // ---------- 크게 보기 · 내려받기 ----------
  const box = $("#big");
  const bigCv = $<HTMLCanvasElement>("#big-cv");
  const bgIn = $<HTMLInputElement>("#big-bg");
  let shown: { art: Artwork | undefined; file: string; img: HTMLImageElement } | null = null;
  const safe = (t: string): string => t.replace(/[\\/:*?"<>|]/g, "_");

  /** 고른 배경색을 깔고 여백까지 합쳐서 보여 준다 (학원에서 정해 둔 색이 처음 값) */
  function paint(): void {
    if (!shown) return;
    const c = composeArt(shown.img, shown.img.naturalWidth, shown.img.naturalHeight, { bg: bgIn.value, pad: shown.art?.pad });
    bigCv.width = c.width;
    bigCv.height = c.height;
    bigCv.getContext("2d")!.drawImage(c, 0, 0);
  }

  function open(file: string): void {
    const art = data.artworks.find((x) => x.file === file);
    const img = new Image();
    img.onload = () => {
      shown = { art, file, img };
      bgIn.value = bgOf(art);
      paint();
      $("#big-name").textContent = art?.name ?? "";
      const raw = $<HTMLAnchorElement>("#big-raw");
      raw.href = `/${file}`;
      raw.download = `${safe(data.name)}_${safe(art?.name ?? "작품")}_원본.${file.split(".").pop() ?? "png"}`;
      box.classList.add("open");
    };
    img.src = `/${file}`;
  }
  bgIn.oninput = paint;
  $("#big-save").onclick = () => {
    if (!shown) return;
    const name = `${safe(data.name)}_${safe(shown.art?.name ?? "작품")}.png`;
    bigCv.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    }, "image/png");
  };
  const close = (): void => box.classList.remove("open");
  $("#big-close").onclick = close;
  box.onclick = (ev) => { if (ev.target === box || ev.target === bigCv.parentElement) close(); };
  window.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });

  await show(0);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const PAGE = `
<style>
  :root { color-scheme: dark }
  html, body { height:100%; margin:0; background:#0e0b16; overflow:hidden }
  body { font:15px/1.5 system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif; color:#f3efe9 }
  #view { position:fixed; inset:0; z-index:0 }
  button, a.btn { font:inherit; padding:6px 12px; border:1px solid #4a4356; border-radius:8px; background:#241f2b;
                  color:#f3efe9; cursor:pointer; text-decoration:none }
  button.on, a.btn.on { background:#e9557d; border-color:#e9557d; color:#fff }
  header { position:fixed; z-index:3; top:0; left:0; right:0; display:flex; gap:10px; align-items:center; flex-wrap:wrap;
           padding:10px 14px; background:linear-gradient(#0e0b16ee,#0e0b1600) }
  header h1 { font-size:17px; margin:0 6px 0 0 }
  #halls, #views { display:flex; gap:4px }
  #note { margin-left:auto; font-size:13px; color:#c9bfd0 }
  #strip { position:fixed; z-index:3; left:0; right:0; bottom:0; display:flex; gap:10px; padding:10px 14px; overflow-x:auto;
           background:linear-gradient(#0e0b1600,#0e0b16ee) }
  #strip img { flex:none; height:72px; max-width:120px; object-fit:contain; border-radius:8px; background:#ffffff14;
               cursor:zoom-in; border:1px solid #ffffff22 }
  #big { display:none; position:fixed; inset:0; z-index:5; background:rgba(8,6,12,.92); flex-direction:column }
  #big.open { display:flex }
  #big .pic { flex:1; min-height:0; display:flex; align-items:center; justify-content:center; padding:12px; overflow:auto }
  #big canvas { max-width:100%; max-height:100%; object-fit:contain; box-shadow:0 2px 18px rgba(0,0,0,.5) }
  #big .bar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding:12px 14px calc(12px + env(safe-area-inset-bottom)) }
  #big .bar b { flex:1; min-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  #big .bar label { display:flex; gap:6px; align-items:center; font-size:14px }
  #big-bg { width:40px; height:30px; padding:0; border:1px solid #4a4356; border-radius:6px; background:none }
</style>
<div id="view"></div>
<header>
  <h1 id="title">전시실</h1>
  <span id="halls"></span>
  <span id="views"></span>
  <span id="note"></span>
</header>
<div id="strip"></div>
<div id="big">
  <div class="pic"><canvas id="big-cv"></canvas></div>
  <div class="bar"><b id="big-name"></b>
    <label>배경색 <input id="big-bg" type="color" value="#ffffff"></label>
    <button id="big-save" class="on">⬇ 이 배경으로 받기</button>
    <a id="big-raw" class="btn" download>⬇ 배경 없는 원본</a>
    <button id="big-close">닫기</button></div>
</div>`;
