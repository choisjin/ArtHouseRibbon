import type { DevicesMsg, MicChoice, ServerMsg } from "../protocol";
import { type AdminCtx, esc } from "./shared";

/**
 * 설정 탭.
 *   마이크      : 마이크를 받는 화면(마이크 화면 ?mode=mic, 또는 TV ?mic=1)마다 장치 고르기·켜기·끄기·음량
 *   TV 소리 출력 : TV 화면마다 출력 장치 고르기·삐 소리 시험
 *   화면 스타일  : 라이트 · 다크 · 기기 설정 따르기 (이 기기에만 저장)
 * 장치는 그 화면이 켜진 컴퓨터에 달려 있어서, 여기서 고르면 서버가 그 화면으로 전달한다 (device.control).
 */
type ThemePref = "light" | "dark" | "system";
const THEME_KEY = "ribbon.admin.theme";
const ROLE_NAME: Record<string, string> = { mic: "마이크 화면", tv: "TV" };
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
        <h2>🎙 마이크</h2>
        <div id="mics" class="agents"></div>
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

  const mics = el.querySelector("#mics") as HTMLElement;
  const outputs = el.querySelector("#outputs") as HTMLElement;
  let last: DevicesMsg | null = null;
  let pending: DevicesMsg | null = null;       // 목록을 고르는 중이면 다 고른 뒤에 다시 그린다
  const send = (m: object) => ctx.socket.sendJson({ type: "device.control", ...m });

  // ---- 마이크 ----
  function renderMics(d: DevicesMsg): void {
    if (!d.mics.length) {
      mics.innerHTML = `<p class="hint">마이크를 받는 화면이 없습니다. 무선 마이크 수신기가 꽂힌 컴퓨터에서
        <a href="/?mode=mic" target="_blank">/?mode=mic</a> 를 열어 두세요 (TV 컴퓨터에 꽂혀 있으면 TV 주소에 <code>&amp;mic=1</code>).</p>`;
      return;
    }
    const kids = ctx.kids();
    mics.innerHTML = d.mics.map((m) => {
      const state = !m.running ? `<span class="pill">꺼짐</span>`
        : m.locked ? `<span class="pill warn">켜졌지만 잠김: 그 화면을 한 번 클릭하세요</span>`
        : `<span class="pill ok">켜짐</span> <span class="hint">${esc(m.opened.map((o) => `${o.label} (${o.channelCount}ch)`).join(", "))}</span>`;
      const sel = (offset: number) => {
        const cur = m.selected.find((s) => s.channelOffset === offset)?.deviceId ?? "";
        return `<select data-offset="${offset}"><option value="">(사용 안 함)</option>${m.devices.map((dv) =>
          `<option value="${esc(dv.deviceId)}" ${dv.deviceId === cur ? "selected" : ""}>${esc(dv.label)}</option>`).join("")}</select>`;
      };
      return `<div class="agent" data-agent="${esc(m.agent)}">
        <div class="row"><b>${ROLE_NAME[m.role] ?? m.role}</b><span class="hint">${esc(m.host)}</span><span class="grow"></span>${state}</div>
        <div class="cols">${SETS.map((s) => `<label>${s.name} ${sel(s.offset)}</label>`).join("")}</div>
        <div class="actions">
          <button data-act="toggle" class="${m.running ? "" : "primary"}">${m.running ? "마이크 끄기" : "마이크 켜기"}</button>
          <button data-act="refresh">장치 다시 찾기</button>
        </div>
        <div class="vu">${[0, 1, 2, 3].map((c) => `<div><div class="bar"><i data-ch="${c}"></i></div>
          <span>${c + 1} ${esc(kids.find((k) => k.mic_channel === c)?.name ?? "-")}</span></div>`).join("")}</div>
        ${m.msg ? `<p class="hint warn-text">${esc(m.msg)}</p>` : ""}
      </div>`;
    }).join("");
    mics.querySelectorAll<HTMLElement>(".agent").forEach((box) => {
      const agent = box.dataset.agent!;
      const m = d.mics.find((x) => x.agent === agent)!;
      const choice = (): MicChoice[] => [...box.querySelectorAll<HTMLSelectElement>("select")]
        .filter((s) => s.value)
        .map((s) => ({ deviceId: s.value, label: s.selectedOptions[0]?.textContent ?? "", channelOffset: Number(s.dataset.offset) }));
      box.querySelectorAll<HTMLSelectElement>("select").forEach((s) => {
        s.onchange = () => {
          // 켜져 있으면 바로 새 장치로 다시 켠다. 꺼져 있으면 '켜기'를 누를 때 쓴다
          if (m.running) { send({ agent, kind: "mic", action: "start", devices: choice() }); ctx.msg("새 장치로 다시 켭니다"); }
        };
      });
      (box.querySelector("[data-act=toggle]") as HTMLButtonElement).onclick = () => {
        if (m.running) { send({ agent, kind: "mic", action: "stop" }); ctx.msg("마이크 끔"); return; }
        const list = choice();
        if (!list.length) { ctx.msg("마이크 장치를 먼저 고르세요", true); return; }
        send({ agent, kind: "mic", action: "start", devices: list });
        ctx.msg("마이크 켜는 중…");
      };
      (box.querySelector("[data-act=refresh]") as HTMLButtonElement).onclick = () => send({ agent, kind: "mic", action: "refresh" });
      setLevels(agent, m.levels);
    });
  }

  function setLevels(agent: string, levels: number[] | undefined): void {
    const box = [...mics.querySelectorAll<HTMLElement>(".agent")].find((b) => b.dataset.agent === agent);
    if (!box || !levels) return;
    box.querySelectorAll<HTMLElement>(".vu i").forEach((bar) => {
      bar.style.height = `${Math.round((levels[Number(bar.dataset.ch)] ?? 0) * 100)}%`;
    });
  }

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
    renderMics(d);
    renderOutputs(d);
  }
  el.addEventListener("focusout", () => setTimeout(() => { if (pending) render(pending); }, 0));

  ctx.socket.on((m: ServerMsg) => {
    if (m.type === "devices") render(m);
    else if (m.type === "devices.levels") setLevels(m.agent, m.levels);
  });
  ctx.onState(() => { if (last && !pending) renderMics(last); });   // 아이 이름(마이크 번호)이 바뀌면
  render({ type: "devices", mics: [], outputs: [] });
  ctx.socket.sendJson({ type: "devices.get" });
  ctx.onState(() => { if (!last?.mics.length && !last?.outputs.length) ctx.socket.sendJson({ type: "devices.get" }); });   // 다시 연결됐을 때
}
