import "./style.css";
import type { AppConfig, KidInfo, ServerMsg, StateMsg } from "../protocol";
import type { RibbonSocket } from "../ws";
import { mountCharacters } from "./characters";
import { mountDashboard } from "./dashboard";
import { mountKids } from "./kids";
import { mountMap } from "./map";
import { applyTheme, mountSettings } from "./settings";
import type { AdminCtx } from "./shared";

/**
 * 관리자 페이지 (?mode=admin). 휴대폰에서도 쓴다 (좁으면 탭이 아래 막대로 간다). 탭:
 *   #dashboard   캐릭터 조작 · TV 방 · 지금 수업 아이들(#dashboard/control) / 수업 시간표(#dashboard/schedule)
 *   #kids        아이 추가·수정 (인적사항, 정규 수업 시간)
 *   #characters  TV 에 나올 캐릭터, 캐릭터별 프로필(#characters/<id> 설정 페이지)
 *   #map         맵 편집기 (방 목록에서 아이들 전시실도 고른다)
 *   #settings    마이크(마이크 화면·TV 의 장치 고르기·켜기), TV 소리 출력, 화면 스타일 (라이트·다크)
 * 저장은 REST API 로, 화면 반영은 서버가 보내는 state 브로드캐스트로 이뤄진다.
 */
const TABS = [
  { id: "dashboard", name: "대시보드", icon: "📋" },
  { id: "kids", name: "아이들", icon: "🧒" },
  { id: "characters", name: "캐릭터", icon: "🎀" },
  { id: "map", name: "맵", icon: "🗺" },
  { id: "settings", name: "설정", icon: "⚙️" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export async function startAdmin(socket: RibbonSocket): Promise<void> {
  document.title = "리본 관리자";
  const root = document.getElementById("app")!;
  root.innerHTML = `
  <div id="admin">
    <header class="topbar">
      <h1>🎀 리본 관리자</h1>
      <nav>${TABS.map((t) => `<a href="#${t.id}" data-tab="${t.id}"><span class="ic">${t.icon}</span><span>${t.name}</span></a>`).join("")}</nav>
      <span id="live" class="live" title="서버 연결">●</span>
    </header>
    ${TABS.map((t) => `<main class="tab" data-panel="${t.id}" hidden></main>`).join("")}
    <p id="admin-msg" class="toast"></p>
  </div>`;
  applyTheme();
  const panel = (id: TabId) => root.querySelector(`[data-panel=${id}]`) as HTMLElement;

  let state: StateMsg | null = null;
  let active: TabId = "dashboard";
  const listeners: ((s: StateMsg) => void)[] = [];
  let toastTimer = 0;
  const ctx: AdminCtx = {
    socket,
    kids: (): KidInfo[] => state?.kids ?? [],
    config: () => (state?.config as AppConfig | undefined) ?? null,
    state: () => state,
    onState(fn) { listeners.push(fn); if (state) fn(state); },
    msg(text, err = false) {
      const el = root.querySelector("#admin-msg") as HTMLElement;
      el.textContent = text;
      el.className = `toast show${err ? " err" : ""}`;
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => { el.className = "toast"; }, err ? 6000 : 3000);
    },
    go(hash) { location.hash = hash; },
  };

  // 탭은 처음 열 때 만든다 (지도·3D 미리보기를 쓰지 않을 때 무겁지 않게)
  const mounted = new Set<TabId>();
  let characters: ReturnType<typeof mountCharacters> | null = null;
  let kidsTab: ReturnType<typeof mountKids> | null = null;
  let mapTab: ReturnType<typeof mountMap> | null = null;
  let dashboard: ReturnType<typeof mountDashboard> | null = null;
  function mount(id: TabId): void {
    if (mounted.has(id)) return;
    mounted.add(id);
    const el = panel(id);
    if (id === "dashboard") dashboard = mountDashboard(el, ctx, () => active === "dashboard");
    if (id === "kids") kidsTab = mountKids(el, ctx);
    if (id === "characters") characters = mountCharacters(el, ctx);
    if (id === "map") mapTab = mountMap(el);
    if (id === "settings") mountSettings(el, ctx);
  }

  function route(): void {
    const [tab, sub] = location.hash.replace(/^#/, "").split("/");
    active = (TABS.some((t) => t.id === tab) ? tab : "dashboard") as TabId;
    mount(active);
    for (const t of TABS) panel(t.id).hidden = t.id !== active;
    root.querySelectorAll<HTMLAnchorElement>("nav a").forEach((a) => a.classList.toggle("on", a.dataset.tab === active));
    root.querySelector("#admin")!.classList.toggle("full", active === "map");
    if (active === "dashboard") dashboard?.show(sub);
    if (active === "characters") characters?.show(sub);
    if (active === "kids" && sub) kidsTab?.select(sub);
    if (active === "map") mapTab?.activate();
  }
  window.addEventListener("hashchange", route);
  route();

  socket.on((m: ServerMsg) => {
    if (m.type === "admin.msg") { ctx.msg(m.text, !!m.error); return; }
    if (m.type !== "state") return;
    state = m;
    root.querySelector("#live")!.classList.add("on");
    for (const fn of listeners) fn(m);
  });
}
