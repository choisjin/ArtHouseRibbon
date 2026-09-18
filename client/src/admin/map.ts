import type { Catalog } from "../world/types";
import { api, type AdminCtx, esc, kidLabel } from "./shared";

/**
 * 맵 탭: 맵 편집기(?mode=editor)를 그대로 넣고, 위에서 편집할 곳을 고른다.
 *   방(미술실·전시장)     → 맵 편집기 (가구·그림·부르면 오는 자리)
 *   아이들 전시실(아이별) → 전시실 꾸미기 (?mode=art&kid=...). 작품 올리기·TV 에서 보기는 그 화면에 있다
 * TV 에 보여줄 방과 배경 렌더 상태도 여기서 본다.
 */
export function mountMap(el: HTMLElement, ctx: AdminCtx): { activate(): void } {
  el.innerHTML = `
    <div class="map">
      <div class="map-bar card">
        <label>편집할 곳 <select id="map-target"></select></label>
        <span class="grow"></span>
        <label>TV 에 보여줄 방 <select id="tv-room"></select></label>
        <a id="map-open" class="button" target="_blank" title="새 창에서 크게">↗ 새 창</a>
      </div>
      <p id="render-info" class="hint"></p>
      <iframe id="map-frame" title="맵 편집기"></iframe>
    </div>`;
  const $ = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
  const target = $("#map-target") as HTMLSelectElement;
  const tvRoom = $("#tv-room") as HTMLSelectElement;
  const frame = $("#map-frame") as HTMLIFrameElement;
  let rooms: [string, string][] = [];
  let loaded = false;

  function fillTargets(): void {
    const keep = target.value;
    const kids = [...ctx.kids()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
    target.innerHTML = `<optgroup label="방 (맵 편집기)">${rooms.map(([id, n]) => `<option value="room:${id}">${esc(n)}</option>`).join("")}</optgroup>`
      + `<optgroup label="아이들 전시실">${kids.map((k) => `<option value="kid:${k.id}">🖼 ${esc(kidLabel(k))} 전시실</option>`).join("")}</optgroup>`;
    if (keep && [...target.options].some((o) => o.value === keep)) target.value = keep;
  }

  function urlOf(v: string): string {
    const [kind, id] = v.split(":");
    return kind === "kid" ? `/?mode=art&kid=${encodeURIComponent(id)}&embed=1` : `/?mode=editor&embed=1#${id}`;
  }

  function open(): void {
    const v = target.value;
    if (!v) return;
    const url = urlOf(v);
    frame.src = url;
    ($("#map-open") as HTMLAnchorElement).href = url.replace("&embed=1", "");
  }
  target.onchange = open;

  tvRoom.onchange = async () => {
    try { await api("PUT", "/api/world/active", { room: tvRoom.value }); ctx.msg(`TV 방: ${tvRoom.selectedOptions[0]?.textContent}`); }
    catch (err) { ctx.msg(String(err), true); }
  };

  async function activate(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const w = await api<{ active: string; catalog: Catalog }>("GET", "/api/world");
      rooms = Object.entries(w.catalog.rooms ?? {}).map(([id, r]) => [id, r.name] as [string, string]);
      tvRoom.innerHTML = rooms.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join("");
      tvRoom.value = w.active;
      fillTargets();
      target.value = rooms.some(([id]) => id === w.active) ? `room:${w.active}` : `room:${rooms[0]?.[0] ?? ""}`;
      open();
    } catch (err) { ctx.msg(`맵 정보를 못 읽음: ${err}`, true); loaded = false; }
  }

  ctx.onState((s) => {
    if (rooms.length) fillTargets();
    const w = s.config?.world;
    if (!w) return;
    if (document.activeElement !== tvRoom && rooms.some(([id]) => id === w.room)) tvRoom.value = w.room;
    const r = w.render;
    $("#render-info").textContent =
      (w.rendering ? `⏳ 배경 렌더 중 (${w.rendering}) · ` : "") +
      (r ? `TV 배경: 블렌더 렌더 ${new Date(r.rendered_at * 1000).toLocaleString()}${r.stale ? " (배치가 바뀌어 다시 렌더 필요)" : ""}`
         : "TV 배경: 렌더 없음 → 실시간 3D");
  });
  return { activate: () => void activate() };
}
