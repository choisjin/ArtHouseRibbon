import "./style.css";
import type { AppConfig, KidInfo, ServerMsg, StateMsg } from "../protocol";
import { Mic } from "../audio/mic";
import { FaceCam } from "../camera/facecam";
import { MusicPlayer } from "../music/player";
import { keepAwake } from "../util/wakelock";
import type { RibbonSocket } from "../ws";
import { mountCharacters } from "./characters";
import { mountDashboard } from "./dashboard";
import { mountGames } from "./games";
import { mountLogs } from "./logs";
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
 *   #games       게임 (카테고리 -> 놀이 목록). 지금은 포켓몬 맞추기 (admin/games.ts)
 *   #logs        날짜별 대화 로그 (admin/logs.ts, 서버 chatlog.py 가 data/logs/ 에 남긴다)
 *   #settings    작은 탭: 마이크 · 카메라 · TV 소리 출력 · 대화 모델(LLM) · 음악 · 계정 · 화면 스타일
 * 이 페이지는 **리모컨**이다: 폰에서 열어도 학원 컴퓨터(맥미니)에서 도는 리본이를 조작한다.
 * 맥미니에서 연 화면(localhost)만 "학원 컴퓨터"로 보고 마이크·카메라·음악 재생을 함께 맡는다 (설정 탭에서 바꿀 수 있다).
 * 저장은 REST API 로, 화면 반영은 서버가 보내는 state 브로드캐스트로 이뤄진다.
 */
const TABS = [
  { id: "dashboard", name: "대시보드" },
  { id: "games", name: "게임" },
  { id: "logs", name: "로그" },
  { id: "kids", name: "아이들" },
  { id: "characters", name: "캐릭터" },
  { id: "map", name: "맵" },
  { id: "settings", name: "설정" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const HOST_KEY = "ribbon.admin.host";

/** 이 브라우저를 학원 컴퓨터로 쓸지. 한 번 고르면 기억한다 (기본: localhost 로 연 화면만 학원 컴퓨터) */
function isHostDevice(): boolean {
  try {
    const v = localStorage.getItem(HOST_KEY);
    if (v !== null) return v === "1";
  } catch { /* 저장소 없음 */ }
  return ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
}

export async function startAdmin(socket: RibbonSocket): Promise<void> {
  document.title = "리본 관리자";
  const root = document.getElementById("app")!;
  root.innerHTML = `
  <div id="admin">
    <header class="topbar">
      <h1>리본 관리자</h1>
      <nav>${TABS.map((t) => `<a href="#${t.id}" data-tab="${t.id}"><span>${t.name}</span></a>`).join("")}</nav>
      <a id="mic-badge" class="mic-badge" href="#settings/mic" hidden></a>
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
  // 이 화면이 학원 컴퓨터(맥미니)인가, 리모컨(폰)인가.
  // 맥미니는 start_ribbon 이 localhost 로 열고, 폰·다른 컴퓨터는 도메인으로 들어온다.
  // 리모컨에서는 마이크·카메라·음악 재생을 켜지 않는다 (학원 컴퓨터에서 돈다). 필요하면 설정에서 바꾼다
  const host = isHostDevice();
  if (host) void keepAwake();        // 마이크를 받는 기기는 화면이 꺼지면 소리가 끊긴다
  const mic = new Mic(socket, { autoStart: host });
  const cam = new FaceCam(socket, { autoStart: host });
  if (host) new MusicPlayer(socket, "admin", "리본 관리자");   // '재생할 곳'이 관리자 페이지일 때 이 컴퓨터가 Spotify 스피커
  const ctx: AdminCtx = {
    socket,
    mic,
    cam,
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
    onMic: () => undefined,           // 아래에서 채운다
    onCam: () => undefined,
    go(hash) { location.hash = hash; },
    host,
    setHost(on) {
      try { localStorage.setItem(HOST_KEY, on ? "1" : "0"); } catch { /* 저장소 없음 */ }
      location.reload();
    },
  };

  // 탭은 처음 열 때 만든다 (지도·3D 미리보기를 쓰지 않을 때 무겁지 않게)
  const mounted = new Set<TabId>();
  let characters: ReturnType<typeof mountCharacters> | null = null;
  let kidsTab: ReturnType<typeof mountKids> | null = null;
  let mapTab: ReturnType<typeof mountMap> | null = null;
  let dashboard: ReturnType<typeof mountDashboard> | null = null;
  let settingsTab: ReturnType<typeof mountSettings> | null = null;
  let logsTab: ReturnType<typeof mountLogs> | null = null;
  let gamesTab: ReturnType<typeof mountGames> | null = null;
  function mount(id: TabId): void {
    if (mounted.has(id)) return;
    mounted.add(id);
    const el = panel(id);
    if (id === "dashboard") dashboard = mountDashboard(el, ctx, () => active === "dashboard");
    if (id === "kids") kidsTab = mountKids(el, ctx);
    if (id === "characters") characters = mountCharacters(el, ctx);
    if (id === "map") mapTab = mountMap(el);
    if (id === "settings") settingsTab = mountSettings(el, ctx);
    if (id === "logs") logsTab = mountLogs(el, ctx);
    if (id === "games") gamesTab = mountGames(el, ctx);
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
    if (active === "settings") settingsTab?.show(sub);
    if (active === "logs") logsTab?.show();
    if (active === "games") gamesTab?.show();
    if (active === "kids" && sub) kidsTab?.select(sub);
    if (active === "map") mapTab?.activate();
  }
  // 위 막대의 마이크 표시: 어느 탭에서든 켜짐·잠김이 보이게
  const badge = root.querySelector("#mic-badge") as HTMLAnchorElement;
  const showMic = () => {
    badge.hidden = !mic.running;
    badge.className = `mic-badge${mic.locked ? " warn" : ""}`;
    badge.textContent = mic.locked ? "잠김: 화면을 한 번 누르세요" : "마이크 켜짐";
  };
  const micListeners: (() => void)[] = [showMic];
  mic.onChange = () => micListeners.forEach((f) => f());
  ctx.onMic = (f) => { micListeners.push(f); };
  const camListeners: (() => void)[] = [];
  cam.onChange = () => camListeners.forEach((f) => f());
  ctx.onCam = (f) => { camListeners.push(f); };
  showMic();

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
