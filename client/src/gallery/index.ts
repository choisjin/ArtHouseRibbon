import * as THREE from "three";
import { Stage, fetchCatalog } from "../tv/stage";
import { renderNow, type Layout, type WorldRender } from "../world/types";

/**
 * 부모님께 보내는 전시실 (?mode=gallery&k=<열쇠>). **보기 전용**이고 로그인하지 않는다.
 *
 * 전시실 꾸미기(?mode=art)의 🔗 공유에서 복사한 주소로 들어온다. 열쇠가 맞으면 서버(GET /api/share/<열쇠>)가
 * 그 아이의 전시실들(1실·2실…)과 걸린 작품을 준다. TV 와 같은 3D 방을 보여 주고,
 * 작품을 누르면(방 안의 그림이든 아래 작은 그림이든) 올린 그대로의 크기로 크게 보고 내려받을 수 있다.
 */
interface Artwork { file: string; name: string; width: number; height: number }
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

  async function show(n: number): Promise<void> {
    hall = n;
    const h = data.halls[n];
    await stage.setWorld(h.room, h.layout, renderNow(h.render));
    const tabs = $("#halls");
    tabs.innerHTML = data.halls.length > 1
      ? data.halls.map((_, i) => `<button data-hall="${i}" class="${i === n ? "on" : ""}">${i + 1}실</button>`).join("") : "";
    tabs.querySelectorAll<HTMLButtonElement>("button").forEach((b) => { b.onclick = () => void show(Number(b.dataset.hall)); });
    // 아래 작은 그림들: 이 방에 걸린 순서대로 (폰에서는 방 안의 그림이 작아 누르기 어렵다)
    const files = [...new Set((h.layout?.arts ?? []).map((a) => a.image))];
    const strip = $("#strip");
    strip.innerHTML = files.map((f) => `<img src="/${esc(f)}" data-file="${esc(f)}" alt="" loading="lazy">`).join("");
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
  function open(file: string): void {
    const a = data.artworks.find((x) => x.file === file);
    $<HTMLImageElement>("#big-img").src = `/${file}`;
    $("#big-name").textContent = a?.name ?? "";
    const link = $<HTMLAnchorElement>("#big-save");
    link.href = `/${file}`;
    link.download = `${data.name}_${(a?.name ?? "작품").replace(/[\\/:*?"<>|]/g, "_")}.${file.split(".").pop() ?? "png"}`;
    box.classList.add("open");
  }
  const close = (): void => box.classList.remove("open");
  $("#big-close").onclick = close;
  box.onclick = (ev) => { if (ev.target === box || ev.target === $("#big-img").parentElement) close(); };
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
  #halls { display:flex; gap:4px }
  #note { margin-left:auto; font-size:13px; color:#c9bfd0 }
  #strip { position:fixed; z-index:3; left:0; right:0; bottom:0; display:flex; gap:10px; padding:10px 14px; overflow-x:auto;
           background:linear-gradient(#0e0b1600,#0e0b16ee) }
  #strip img { flex:none; height:72px; max-width:120px; object-fit:contain; border-radius:8px; background:#ffffff14;
               cursor:zoom-in; border:1px solid #ffffff22 }
  #big { display:none; position:fixed; inset:0; z-index:5; background:rgba(8,6,12,.92); flex-direction:column }
  #big.open { display:flex }
  #big .pic { flex:1; min-height:0; display:flex; align-items:center; justify-content:center; padding:12px; overflow:auto }
  #big img { max-width:100%; max-height:100%; object-fit:contain }
  #big .bar { display:flex; gap:10px; align-items:center; padding:12px 14px calc(12px + env(safe-area-inset-bottom)) }
  #big .bar b { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
</style>
<div id="view"></div>
<header>
  <h1 id="title">전시실</h1>
  <span id="halls"></span>
  <span id="note"></span>
</header>
<div id="strip"></div>
<div id="big">
  <div class="pic"><img id="big-img" alt=""></div>
  <div class="bar"><b id="big-name"></b>
    <a id="big-save" class="btn on" download>⬇ 내려받기</a>
    <button id="big-close">닫기</button></div>
</div>`;
