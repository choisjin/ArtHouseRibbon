import type { MicChoice } from "../audio/mic";
import type { DevicesMsg, ServerMsg } from "../protocol";
import { type AdminCtx, esc } from "./shared";

/**
 * 설정 탭.
 *   마이크      : 이 컴퓨터에서 마이크 받기 (예전 마이크 화면 ?mode=mic 의 기능 전부). 장치 고르기·켜기·끄기·음량.
 *                 무선 마이크 수신기가 꽂힌 컴퓨터에서 관리자 페이지를 열어 두면 된다 (audio/mic.ts)
 *   TV 소리 출력 : TV 화면마다 출력 장치 고르기·삐 소리 시험. 출력 장치는 TV 컴퓨터에 달려 있어서
 *                 여기서 고르면 서버가 그 TV 로 전달한다 (device.control)
 *   화면 스타일  : 라이트 · 다크 · 기기 설정 따르기 (이 기기에만 저장)
 */
type ThemePref = "light" | "dark" | "system";
const THEME_KEY = "ribbon.admin.theme";
const ROLE_NAME: Record<string, string> = { tv: "TV" };
const SETS = [{ offset: 0, name: "1세트 (마이크 1·2)" }, { offset: 2, name: "2세트 (마이크 3·4)" }];

function readPref(): ThemePref {
  try { return (localStorage.getItem(THEME_KEY) as ThemePref) || "system"; } catch { return "system"; }
}

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

/** 관리자 페이지에 테마를 입힌다 (처음 열 때와 바꿀 때) */
export function applyTheme(pref: ThemePref = readPref()): void {
  const theme = pref === "system" ? (systemDark.matches ? "dark" : "light") : pref;
  document.getElementById("admin")?.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;     // 달력·스크롤바 같은 기본 부품 색
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0e0b16" : "#f6f3fa");
}
systemDark.addEventListener("change", () => { if (readPref() === "system") applyTheme("system"); });

export function mountSettings(el: HTMLElement, ctx: AdminCtx): void {
  const themes: [ThemePref, string, string][] = [
    ["light", "☀️ 라이트", "밝은 화면"],
    ["dark", "🌙 다크", "어두운 화면"],
    ["system", "📱 기기 설정 따르기", "휴대폰·컴퓨터의 다크 모드를 따라갑니다"],
  ];
  el.innerHTML = `
    <div class="settings">
      <section class="card">
        <h2>🎙 마이크 <small class="hint">이 컴퓨터에서 받기</small></h2>
        <div id="mic" class="agent"></div>
        <p class="hint">무선 마이크 수신기가 꽂힌 컴퓨터(맥미니)에서 이 관리자 페이지를 열어 두세요. 한 번 켜 두면 이 브라우저가 기억해서
          다음에 열 때 자동으로 켭니다. <b>이 창을 닫으면 리본이가 듣지 못합니다.</b> 다른 탭으로 옮겨도 계속 받습니다.</p>
      </section>
      <section class="card">
        <h2>🔈 TV 소리 출력</h2>
        <div id="outputs" class="agents"></div>
      </section>
      <section class="card">
        <h2>화면 스타일</h2>
        <div class="theme-options">
          ${themes.map(([v, n, d]) => `<label class="theme-opt"><input type="radio" name="theme" value="${v}" /><b>${n}</b><span class="hint">${d}</span></label>`).join("")}
        </div>
        <p class="hint">이 기기에만 저장됩니다. 맵 편집기 화면은 스타일이 따로 있습니다.</p>
      </section>
    </div>`;
  const cur = readPref();
  el.querySelectorAll<HTMLInputElement>("input[name=theme]").forEach((r) => {
    r.checked = r.value === cur;
    r.onchange = () => {
      try { localStorage.setItem(THEME_KEY, r.value); } catch { /* 저장소 없음: 이번에만 */ }
      applyTheme(r.value as ThemePref);
    };
  });

  const micBox = el.querySelector("#mic") as HTMLElement;
  const outputs = el.querySelector("#outputs") as HTMLElement;
  let last: DevicesMsg | null = null;
  let pending: DevicesMsg | null = null;       // 목록을 고르는 중이면 다 고른 뒤에 다시 그린다
  const send = (m: object) => ctx.socket.sendJson({ type: "device.control", ...m });

  // ---- 마이크 (이 컴퓨터) ----
  const mic = ctx.mic;
  function renderMic(): void {
    if (micBox.contains(document.activeElement) && document.activeElement?.tagName === "SELECT") return;   // 고르는 중
    const kids = ctx.kids();
    const state = !mic.running ? `<span class="pill">꺼짐</span>`
      : mic.locked ? `<span class="pill warn">켜졌지만 잠김: 이 화면을 한 번 누르세요</span>`
      : `<span class="pill ok">켜짐</span> <span class="hint">${esc(mic.capture.opened.map((o) => `${o.label} (${o.channelCount}ch)`).join(", "))}</span>`;
    if (!mic.listed) {
      micBox.innerHTML = `<div class="row"><b>이 컴퓨터</b><span class="grow"></span>${state}</div>
        <p class="hint">마이크 장치를 찾으려면 브라우저가 마이크 권한을 물어봅니다.</p>
        <div class="actions"><button data-act="find" class="primary">마이크 장치 찾기</button></div>`;
      (micBox.querySelector("[data-act=find]") as HTMLButtonElement).onclick = () => void mic.refresh();
      return;
    }
    const sel = (offset: number) => {
      const cur = mic.selected.find((x) => x.channelOffset === offset)?.deviceId ?? "";
      return `<select data-offset="${offset}"><option value="">(사용 안 함)</option>${mic.devices.map((dv) =>
        `<option value="${esc(dv.deviceId)}" ${dv.deviceId === cur ? "selected" : ""}>${esc(dv.label)}</option>`).join("")}</select>`;
    };
    micBox.innerHTML = `
      <div class="row"><b>이 컴퓨터</b><span class="grow"></span>${state}</div>
      <div class="cols">${SETS.map((x) => `<label>${x.name} ${sel(x.offset)}</label>`).join("")}</div>
      <div class="actions">
        <button data-act="toggle" class="${mic.running ? "" : "primary"}">${mic.running ? "마이크 끄기" : "마이크 켜기"}</button>
        <button data-act="refresh">장치 다시 찾기</button>
      </div>
      <div class="vu">${[0, 1, 2, 3].map((c) => `<div><div class="bar"><i data-ch="${c}"></i></div>
        <span>${c + 1} ${esc(kids.find((k) => k.mic_channel === c)?.name ?? "-")}</span></div>`).join("")}</div>
      ${mic.msg ? `<p class="hint warn-text">${esc(mic.msg)}</p>` : ""}`;
    const choice = (): MicChoice[] => [...micBox.querySelectorAll<HTMLSelectElement>("select")]
      .filter((x) => x.value)
      .map((x) => ({ deviceId: x.value, label: x.selectedOptions[0]?.textContent ?? "", channelOffset: Number(x.dataset.offset) }));
    micBox.querySelectorAll<HTMLSelectElement>("select").forEach((x) => {
      x.onchange = () => { if (mic.running) { void mic.start(choice()); ctx.msg("새 장치로 다시 켭니다"); } };   // 켜져 있으면 바로 바꾼다
      x.onblur = () => renderMic();
    });
    (micBox.querySelector("[data-act=toggle]") as HTMLButtonElement).onclick = () => {
      if (mic.running) { void mic.stop(); ctx.msg("마이크 끔 (다음에 열 때 자동으로 켜지 않습니다)"); return; }
      const list = choice();
      if (!list.length) { ctx.msg("마이크 장치를 먼저 고르세요", true); return; }
      void mic.start(list);
    };
    (micBox.querySelector("[data-act=refresh]") as HTMLButtonElement).onclick = () => void mic.refresh();
  }
  ctx.onMic(renderMic);
  renderMic();
  // 음량 막대 (보일 때만)
  setInterval(() => {
    if (!micBox.isConnected || micBox.offsetParent === null) return;
    micBox.querySelectorAll<HTMLElement>(".vu i").forEach((bar) => {
      bar.style.height = `${Math.round(mic.level(Number(bar.dataset.ch)) * 100)}%`;
    });
  }, 80);

  // ---- TV 소리 출력 ----
  function renderOutputs(d: DevicesMsg): void {
    if (!d.outputs.length) {
      outputs.innerHTML = `<p class="hint">켜진 TV 화면이 없습니다. TV 컴퓨터에서 리본 TV 화면(<a href="/?mode=tv" target="_blank">/?mode=tv</a>)을 열어 두세요.</p>`;
      return;
    }
    outputs.innerHTML = d.outputs.map((o) => `<div class="agent" data-agent="${esc(o.agent)}">
        <div class="row"><b>${ROLE_NAME[o.role] ?? o.role}</b><span class="hint">${esc(o.host)}</span><span class="grow"></span>
          ${o.locked ? `<span class="pill warn">소리 잠김: TV 화면을 한 번 클릭하세요</span>` : `<span class="pill ok">소리 켜짐</span>`}</div>
        <label>출력 장치 <select ${o.supported ? "" : "disabled"}>
          <option value="">시스템 기본 출력</option>
          ${o.devices.map((dv) => `<option value="${esc(dv.deviceId)}" ${dv.deviceId === o.current ? "selected" : ""}>${esc(dv.label)}</option>`).join("")}
        </select></label>
        <div class="actions">
          <button data-act="beep">🔊 삐 소리 시험</button>
          <button data-act="labels" title="TV 컴퓨터에서 마이크 권한을 물어볼 수 있습니다">장치 이름 보기</button>
        </div>
        ${o.supported ? "" : `<p class="hint warn-text">이 TV 브라우저는 출력 장치 선택을 지원하지 않습니다 (Chrome 110 이상)</p>`}
        ${o.msg ? `<p class="hint warn-text">${esc(o.msg)}</p>` : ""}
      </div>`).join("");
    outputs.querySelectorAll<HTMLElement>(".agent").forEach((box) => {
      const agent = box.dataset.agent!;
      const sel = box.querySelector("select") as HTMLSelectElement;
      sel.onchange = () => { send({ agent, kind: "output", action: "set", deviceId: sel.value }); ctx.msg(`TV 소리 → ${sel.selectedOptions[0]?.textContent}`); };
      (box.querySelector("[data-act=beep]") as HTMLButtonElement).onclick = () => send({ agent, kind: "output", action: "beep" });
      (box.querySelector("[data-act=labels]") as HTMLButtonElement).onclick = () => {
        send({ agent, kind: "output", action: "labels" });
        ctx.msg("TV 컴퓨터에서 마이크 권한을 허용하면 장치 이름이 보입니다");
      };
    });
  }

  function render(d: DevicesMsg): void {
    // 목록을 펼쳐 고르는 중에 다시 그리면 선택이 날아간다 → 포커스가 빠지면 그린다
    if (el.contains(document.activeElement) && document.activeElement?.tagName === "SELECT") { pending = d; return; }
    pending = null;
    last = d;
    renderOutputs(d);
  }
  el.addEventListener("focusout", () => setTimeout(() => { if (pending) render(pending); }, 0));

  ctx.socket.on((m: ServerMsg) => {
    if (m.type === "devices") render(m);
  });
  let kidsKey = "";
  ctx.onState((st) => {
    const key = st.kids.map((k) => `${k.name}:${k.mic_channel}`).join(",");
    if (key !== kidsKey) { kidsKey = key; renderMic(); }                  // 음량 막대 아래 아이 이름
    if (!last?.outputs.length) ctx.socket.sendJson({ type: "devices.get" });   // 다시 연결됐을 때
  });
  render({ type: "devices", outputs: [] });
  ctx.socket.sendJson({ type: "devices.get" });
}
