import type { MicChoice } from "../audio/mic";
import type { DevicesMsg, LLMConfig, ServerMsg } from "../protocol";
import { mountAccounts } from "./accounts";
import { mountMusic } from "./music";
import { type AdminCtx, api, esc } from "./shared";

/**
 * 설정 탭. 항목마다 작은 탭으로 나눈다 (#settings/mic, cam, output, llm, theme). 스크롤 없이 한 화면에 한 항목.
 *   마이크      : 이 컴퓨터에서 마이크 받기 (예전 마이크 화면 ?mode=mic 의 기능 전부). 장치 고르기·켜기·끄기·음량.
 *                 무선 마이크 수신기가 꽂힌 컴퓨터에서 관리자 페이지를 열어 두면 된다 (audio/mic.ts)
 *   카메라      : 이 컴퓨터의 웹캠으로 TV 앞 얼굴 찾기 (camera/facecam.ts). 장치 고르기·켜기·끄기·미리보기.
 *                 웹캠이 꽂힌 컴퓨터(맥미니)에서 관리자 페이지를 열어 두면 된다. 얼굴 위치만 서버를 거쳐 TV 로 간다
 *   TV 소리 출력 : TV 화면마다 출력 장치 고르기·삐 소리 시험. 출력 장치는 TV 컴퓨터에 달려 있어서
 *                 여기서 고르면 서버가 그 TV 로 전달한다 (device.control)
 *   대화 모델    : 리본이가 답할 때 쓰는 LLM (맥미니 mlx-serve / Ollama …). 저장하면 서버를 다시 켜지 않아도 다음 답부터 바뀐다.
 *                 .env 의 RIBBON_LLM_* 는 처음 한 번 이 칸을 채우는 데만 쓴다
 *   음악        : Spotify (admin/music.ts): 플레이어 · 내 목록 관리 · 노래 검색 · 계정 설정 모달
 *                 (서버 music.py · music_intent.py, 재생 화면 music/player.ts)
 *   계정        : 가입한 사람 목록·권한(admin/member)·내 비밀번호 (admin/accounts.ts, 서버 auth.py)
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

export function mountSettings(el: HTMLElement, ctx: AdminCtx): { show(sub?: string): void } {
  const themes: [ThemePref, string, string][] = [
    ["light", "☀️ 라이트", "밝은 화면"],
    ["dark", "🌙 다크", "어두운 화면"],
    ["system", "📱 기기 설정 따르기", "휴대폰·컴퓨터의 다크 모드를 따라갑니다"],
  ];
  el.innerHTML = `
    <div class="subtabs seg many">
      <button data-sub="mic">🎙 마이크</button><button data-sub="cam">📷 카메라</button><button data-sub="output">🔈 TV 소리</button><button data-sub="llm">🧠 대화 모델</button><button data-sub="music">🎵 음악</button><button data-sub="accounts">👤 계정</button><button data-sub="theme">🎨 화면</button>
    </div>
    <div class="settings">
      <section class="card" data-subpanel="mic" hidden>
        <h2>🎙 마이크 <small class="hint">이 컴퓨터에서 받기</small></h2>
        <div data-role="role-note"></div>
        <div id="mic" class="agent"></div>
        <hr />
        <h3>🔘 주소로 리본이 부르기</h3>
        <p class="hint">폰에 DJI 수신기를 꽂으면 송신기 버튼이 <b>폰 볼륨만 올립니다</b> (웹페이지는 USB 장치를 잡을 수 없습니다).
          폰의 매크로 앱(MacroDroid·Tasker)에서 <b>볼륨 올림 키</b>를 눌렀을 때 아래 주소를 열게 하면 호출 버튼과 똑같이 동작합니다.
          블루투스 리모컨이나 TV 화면의 "🎤 리본아!" 단추를 써도 됩니다.</p>
        <div class="row"><code class="grow" data-role="call-url"></code><button data-act="copy-call">복사</button></div>
        <hr />
        <p class="hint">무선 마이크 수신기가 꽂힌 컴퓨터(맥미니)에서 이 관리자 페이지를 열어 두세요. 한 번 켜 두면 이 브라우저가 기억해서
          다음에 열 때 자동으로 켭니다. <b>이 창을 닫으면 리본이가 듣지 못합니다.</b> 다른 탭으로 옮겨도 계속 받습니다.</p>
      </section>
      <section class="card" data-subpanel="cam" hidden>
        <h2>📷 카메라 <small class="hint">이 컴퓨터에서 받기</small></h2>
        <div data-role="role-note"></div>
        <div id="cam" class="agent"></div>
        <p class="hint">TV 위에 단 웹캠으로 아이들 얼굴 위치를 찾아 리본이가 그쪽을 바라봅니다. 영상은 저장하거나 보내지 않습니다.
          마이크처럼 한 번 켜 두면 이 브라우저가 기억해서 다음에 열 때 자동으로 켭니다. <b>이 창을 닫으면 리본이가 아이들을 보지 못합니다.</b></p>
        <hr />
        <h3>📱 폰으로 작품 찍어 보내기</h3>
        <p class="hint">폰 카메라로 QR 을 찍으면 작품 찍는 화면이 열립니다. 찍어서 보내면 그 아이 작품으로 저장됩니다
          (전시실 벽에 거는 것은 <a href="/?mode=art" target="_blank">전시실 꾸미기</a>에서).</p>
        <div class="snapqr">
          <canvas data-role="qr" width="180" height="180"></canvas>
          <div>
            <p class="hint" data-role="snap-url"></p>
            <p class="hint" data-role="snap-warn"></p>
          </div>
        </div>
      </section>
      <section class="card" data-subpanel="output" hidden>
        <h2>🔈 TV 소리 출력</h2>
        <div id="outputs" class="agents"></div>
      </section>
      <section class="card" data-subpanel="llm" hidden>
        <h2>🧠 대화 모델 <small class="hint">리본이가 답할 때 쓰는 AI</small></h2>
        <div id="llm" class="agent">
          <label>어디서 <select name="provider">
            <option value="mlx">MLX (맥미니 mlx-serve)</option>
            <option value="ollama">Ollama</option>
            <option value="openai">기타 OpenAI 호환 서버</option>
            <option value="mock">시험용 (모델 없이 정해진 답)</option>
          </select></label>
          <label>모델 <input name="model" list="llm-models" autocomplete="off" spellcheck="false" /></label>
          <datalist id="llm-models"></datalist>
          <details><summary class="hint">서버 주소 (보통은 비워 둡니다)</summary>
            <label>주소 <input name="base_url" spellcheck="false" /></label>
          </details>
          <p class="hint" data-role="list"></p>
          <div class="actions">
            <button data-act="save" class="primary">저장</button>
            <button data-act="test">💬 시험해 보기</button>
            <button data-act="reload">모델 목록 다시 읽기</button>
          </div>
          <p class="hint" data-role="result"></p>
        </div>
        <p class="hint">저장하면 서버를 다시 켜지 않아도 리본이의 다음 대답부터 바뀝니다. 맥미니에서는 MLX 를 씁니다.</p>
      </section>
      <div class="music-tab" data-subpanel="music" hidden></div>
      <div class="music-tab" data-subpanel="accounts" hidden></div>
      <section class="card" data-subpanel="theme" hidden>
        <h2>🎨 화면 스타일</h2>
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
  const camBox = el.querySelector("#cam") as HTMLElement;
  let last: DevicesMsg | null = null;
  let pending: DevicesMsg | null = null;       // 목록을 고르는 중이면 다 고른 뒤에 다시 그린다
  const send = (m: object) => ctx.socket.sendJson({ type: "device.control", ...m });

  // ---- 대화 모델 ----
  const llmBox = el.querySelector("#llm") as HTMLElement;
  const provSel = llmBox.querySelector("[name=provider]") as HTMLSelectElement;
  const modelIn = llmBox.querySelector("[name=model]") as HTMLInputElement;
  const urlIn = llmBox.querySelector("[name=base_url]") as HTMLInputElement;
  const listLine = llmBox.querySelector("[data-role=list]") as HTMLElement;
  const result = llmBox.querySelector("[data-role=result]") as HTMLElement;
  const datalist = el.querySelector("#llm-models") as HTMLDataListElement;
  const URLS: Record<string, string> = { mlx: "http://localhost:11234/v1", ollama: "http://localhost:11434/v1", openai: "http://localhost:8080/v1" };
  let llmShown = "";          // 화면에 채운 설정 (다른 곳에서 바뀌었을 때만 다시 채운다)
  function fillLlm(c: LLMConfig): void {
    provSel.value = c.provider;
    modelIn.value = c.model;
    urlIn.value = c.base_url;
    urlIn.placeholder = URLS[c.provider] ?? "";
    modelIn.disabled = urlIn.disabled = c.provider === "mock";
  }
  let listSeq = 0;            // 늦게 온 옛 목록 응답은 버린다 (제공자·주소를 연달아 바꿀 때)
  async function loadModels(): Promise<void> {
    const seq = ++listSeq;
    const provider = provSel.value;
    datalist.innerHTML = "";
    if (provider === "mock") { listLine.textContent = ""; return; }
    listLine.textContent = "모델 목록을 읽는 중…";
    type R = { ok: boolean; models?: { id: string; loaded: boolean | null }[]; error?: string };
    const q = new URLSearchParams({ provider, base_url: urlIn.value.trim() });
    const r = await api<R>("GET", `/api/llm/models?${q}`).catch((e) => ({ ok: false, error: String(e) }) as R);
    if (seq !== listSeq) return;
    if (!r.ok) { listLine.innerHTML = `<span class="warn-text">서버에 연결하지 못했습니다: ${esc(r.error)}</span>`; return; }
    const models = r.models ?? [];
    datalist.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${m.loaded ? "올라가 있음" : ""}</option>`).join("");
    if (!modelIn.value && models.length) modelIn.value = (models.find((m) => m.loaded) ?? models[0]).id;
    const known = models.some((m) => m.id === modelIn.value);
    listLine.innerHTML = `모델 ${models.length}개를 찾았습니다.` +
      (modelIn.value && !known ? ` <span class="warn-text">지금 적힌 모델은 이 서버에 없습니다.</span>` : "");
  }
  provSel.onchange = () => {
    // 제공자를 바꾸면 주소·모델은 그 제공자 것으로 다시 고른다
    fillLlm({ provider: provSel.value as LLMConfig["provider"], base_url: "", model: "" });
    void loadModels();
  };
  urlIn.onchange = () => void loadModels();
  (llmBox.querySelector("[data-act=reload]") as HTMLButtonElement).onclick = () => void loadModels();
  (llmBox.querySelector("[data-act=save]") as HTMLButtonElement).onclick = async () => {
    const body = { provider: provSel.value, base_url: urlIn.value.trim(), model: modelIn.value.trim() };
    if (body.provider !== "mock" && !body.model) { ctx.msg("모델을 고르세요", true); return; }
    try {
      const saved = await api<LLMConfig>("PUT", "/api/config/llm", body);
      llmShown = JSON.stringify(saved);
      ctx.msg(`대화 모델 저장: ${saved.provider === "mock" ? "시험용" : saved.model}`);
    } catch (e) { ctx.msg(`저장 실패: ${e}`, true); }
  };
  (llmBox.querySelector("[data-act=test]") as HTMLButtonElement).onclick = async () => {
    result.textContent = "물어보는 중… (저장된 모델로)";
    type R = { ok: boolean; text?: string; first_s?: number; total_s?: number; model?: string; error?: string };
    const r = await api<R>("POST", "/api/llm/test").catch((e) => ({ ok: false, error: String(e) }) as R);
    result.innerHTML = r.ok
      ? `<b>${esc(r.text)}</b><br>첫 글자 ${r.first_s}초 · 전체 ${r.total_s}초 · ${esc(r.model)}`
      : `<span class="warn-text">실패: ${esc(r.error)}</span>`;
  };
  ctx.onState((st) => {
    const c = st.config?.llm;
    if (!c || JSON.stringify(c) === llmShown || llmBox.contains(document.activeElement)) return;
    const first = !llmShown;
    llmShown = JSON.stringify(c);
    fillLlm(c);
    if (first) void loadModels();
  });

  // ---- 이 화면이 학원 컴퓨터인가, 리모컨인가 ----
  el.querySelectorAll<HTMLElement>("[data-role=role-note]").forEach((note) => {
    note.className = "role-note";
    note.innerHTML = ctx.host
      ? `<b>🖥 이 화면이 학원 컴퓨터입니다.</b> 마이크·카메라·음악 재생을 이 컴퓨터가 맡습니다.
         <button data-act="to-remote">리모컨으로 바꾸기</button>`
      : `<b>📱 이 화면은 리모컨입니다.</b> 마이크·카메라는 학원 컴퓨터(맥미니)에서 돕니다.
         여기서 켜면 <b>이 기기</b>의 마이크·카메라를 쓰게 됩니다.
         <button data-act="to-host">이 기기를 학원 컴퓨터로 쓰기</button>`;
    note.querySelector("[data-act=to-remote]")?.addEventListener("click", () => ctx.setHost(false));
    note.querySelector("[data-act=to-host]")?.addEventListener("click", () => {
      if (confirm("이 기기의 마이크·카메라를 쓰고 음악도 여기서 재생할까요? (보통은 학원 컴퓨터에서만 켭니다)")) ctx.setHost(true);
    });
  });

  // ---- 주소로 호출하기 (마이크 탭): 폰 매크로 앱이 DJI 버튼을 잡아 부를 때 ----
  const callUrlEl = el.querySelector("[data-role=call-url]") as HTMLElement;
  let callUrl = "";
  ctx.onState((st) => {
    const token = st.config?.ribbon?.call_token;
    if (!token) return;
    const base = (netBase || location.origin).replace(/\/$/, "");
    callUrl = `${base}/api/call?token=${encodeURIComponent(token)}`;
    callUrlEl.textContent = callUrl;
  });
  (el.querySelector("[data-act=copy-call]") as HTMLButtonElement).onclick = () => {
    navigator.clipboard?.writeText(callUrl)
      .then(() => ctx.msg("복사했습니다"), () => ctx.msg("복사하지 못했습니다. 직접 골라 복사하세요", true));
  };

  // ---- 폰으로 작품 찍어 보내기: 주소 QR (카메라 탭) ----
  let netBase = "";
  void (async () => {
    const box = el.querySelector("[data-role=snap-url]") as HTMLElement;
    const warn = el.querySelector("[data-role=snap-warn]") as HTMLElement;
    const net = await api<{ urls: string[]; public: string }>("GET", "/api/net").catch(() => null);
    const base = net?.public || net?.urls[0] || location.origin;
    netBase = base;
    const url = `${base.replace(/\/$/, "")}/?mode=snap`;
    box.innerHTML = `<b>${esc(url)}</b>`;
    warn.innerHTML = url.startsWith("https:")
      ? `폰에서 이 주소로 들어가면 화면 안에서 바로 찍을 수도 있습니다.`
      : `<span class="warn-text">http 주소라 폰 브라우저가 카메라를 막습니다.</span> 폰의 기본 카메라 앱으로 찍어 보내는 방식으로 동작합니다.
         도메인(https)을 붙이려면 <code>docs/REMOTE.md</code> 를 보세요.`;
    try {
      const QR = (await import("qrcode")).default;
      await QR.toCanvas(el.querySelector("[data-role=qr]") as HTMLCanvasElement, url, { width: 180, margin: 1 });
    } catch (e) { warn.innerHTML += `<br>QR 을 만들지 못했습니다: ${esc(String(e))}`; }
  })();

  // ---- 음악 (Spotify): 플레이어·목록·검색·계정 모달은 admin/music.ts 가 전부 그린다 ----
  const accounts = mountAccounts(el.querySelector('[data-subpanel=accounts]') as HTMLElement, ctx);
  const music = mountMusic(el.querySelector('[data-subpanel=music]') as HTMLElement, ctx);

  // ---- 마이크 (이 컴퓨터) ----
  const mic = ctx.mic;
  let micStale = false;          // 고르는 중이라 다시 그리기를 미뤘다
  function renderMic(): void {
    if (micBox.contains(document.activeElement) && document.activeElement?.tagName === "SELECT") { micStale = true; return; }   // 고르는 중
    micStale = false;
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
      // 고른 것을 기억해 둔다 (다시 그려도 그대로). 켜져 있으면 바로 바꾼다
      x.onchange = () => { if (mic.running) { void mic.start(choice()); ctx.msg("새 장치로 다시 켭니다"); } else mic.selected = choice(); };
      // 미뤄 둔 것만 그린다. 그냥 다시 그리면 "마이크 켜기"를 누르는 순간 버튼이 바뀌어 클릭이 사라진다
      x.onblur = () => { if (micStale) renderMic(); };
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

  // ---- 카메라 (이 컴퓨터) ----
  const cam = ctx.cam;
  let camStale = false;
  function renderCam(): void {
    if (camBox.contains(document.activeElement) && document.activeElement?.tagName === "SELECT") { camStale = true; return; }   // 고르는 중
    camStale = false;
    const state = cam.running ? `<span class="pill ok">켜짐</span> <span class="hint">${esc(cam.using)}</span>` : `<span class="pill">꺼짐</span>`;
    if (!cam.listed) {
      camBox.innerHTML = `<div class="row"><b>이 컴퓨터</b><span class="grow"></span>${state}</div>
        <p class="hint">카메라 장치를 찾으려면 브라우저가 카메라 권한을 물어봅니다.</p>
        <div class="actions"><button data-act="find" class="primary">카메라 장치 찾기</button></div>
        ${cam.msg ? `<p class="hint warn-text">${esc(cam.msg)}</p>` : ""}`;
      (camBox.querySelector("[data-act=find]") as HTMLButtonElement).onclick = () => void cam.refresh();
      return;
    }
    camBox.innerHTML = `
      <div class="row"><b>이 컴퓨터</b><span class="grow"></span>${state}</div>
      <label>카메라 <select>${cam.devices.map((dv) =>
        `<option value="${esc(dv.deviceId)}" ${dv.deviceId === cam.saved.deviceId ? "selected" : ""}>${esc(dv.label)}</option>`).join("")}</select></label>
      <div class="actions">
        <button data-act="toggle" class="${cam.running ? "" : "primary"}">${cam.running ? "카메라 끄기" : "카메라 켜기"}</button>
        <button data-act="refresh">장치 다시 찾기</button>
      </div>
      ${cam.running ? `<canvas class="cam-preview" style="width:100%;max-width:480px;border-radius:10px;background:#000;display:block;margin-top:8px"></canvas>` : ""}
      ${cam.msg ? `<p class="hint warn-text">${esc(cam.msg)}</p>` : ""}`;
    const sel = camBox.querySelector("select") as HTMLSelectElement;
    sel.onchange = () => { if (cam.running) { void cam.start(sel.value); ctx.msg("새 카메라로 다시 켭니다"); } else cam.choose(sel.value); };
    sel.onblur = () => { if (camStale) renderCam(); };
    (camBox.querySelector("[data-act=toggle]") as HTMLButtonElement).onclick = () => {
      if (cam.running) { void cam.stop(); ctx.msg("카메라 끔 (다음에 열 때 자동으로 켜지 않습니다)"); return; }
      if (!sel.value) { ctx.msg("카메라 장치를 먼저 고르세요", true); return; }
      ctx.msg("카메라를 켜는 중 (처음에는 몇 초 걸립니다)");
      void cam.start(sel.value);
    };
    (camBox.querySelector("[data-act=refresh]") as HTMLButtonElement).onclick = () => void cam.refresh();
  }
  ctx.onCam(renderCam);
  renderCam();
  // 미리보기: 거울처럼 뒤집어 보이고 찾은 얼굴에 상자를 친다 (보일 때만 그린다)
  const drawCam = () => {
    requestAnimationFrame(drawCam);
    const c = camBox.querySelector<HTMLCanvasElement>(".cam-preview");
    const v = cam.video;
    if (!c || !cam.running || c.offsetParent === null || !v.videoWidth) return;
    c.width = 480; c.height = Math.round(480 * v.videoHeight / v.videoWidth);
    const g = c.getContext("2d")!;
    g.setTransform(-1, 0, 0, 1, c.width, 0);
    g.drawImage(v, 0, 0, c.width, c.height);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.strokeStyle = "#ff5fa2"; g.lineWidth = 3;
    for (const b of cam.boxes) g.strokeRect((1 - b.x1) * c.width, b.y0 * c.height, (b.x1 - b.x0) * c.width, (b.y1 - b.y0) * c.height);
    g.fillStyle = "rgba(0,0,0,.55)"; g.fillRect(0, 0, c.width, 26);
    g.fillStyle = "#fff"; g.font = "16px sans-serif";
    g.fillText(`얼굴 ${cam.boxes.length}명`, 8, 19);
  };
  requestAnimationFrame(drawCam);

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
          ${o.mobile ? "" : `<button data-act="labels" title="TV 컴퓨터에서 마이크 권한을 물어볼 수 있습니다">장치 이름 보기</button>`}
        </div>
        ${o.mobile
          ? `<p class="hint">이 TV 화면은 <b>폰·태블릿</b>입니다. 출력 장치는 고를 수 없고 소리는 그 기기 설정(스피커·HDMI·블루투스)을 따릅니다.
             삐 소리는 <b>그 기기에서 TV 화면이 앞에 떠 있고</b> 화면을 한 번 누른 뒤에만 납니다.</p>`
          : o.supported ? "" : `<p class="hint warn-text">이 TV 브라우저는 출력 장치 선택을 지원하지 않습니다 (Chrome 110 이상)</p>`}
        ${o.msg ? `<p class="hint warn-text">${esc(o.msg)}</p>` : ""}
      </div>`).join("");
    outputs.querySelectorAll<HTMLElement>(".agent").forEach((box) => {
      const agent = box.dataset.agent!;
      const sel = box.querySelector("select") as HTMLSelectElement;
      sel.onchange = () => { send({ agent, kind: "output", action: "set", deviceId: sel.value }); ctx.msg(`TV 소리 → ${sel.selectedOptions[0]?.textContent}`); };
      (box.querySelector("[data-act=beep]") as HTMLButtonElement).onclick = () => send({ agent, kind: "output", action: "beep" });
      const labels = box.querySelector("[data-act=labels]") as HTMLButtonElement | null;
      if (labels) labels.onclick = () => {
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

  // ---- 작은 탭 (마지막으로 본 것을 기억, 주소는 #settings/mic 처럼) ----
  const SUBS = ["mic", "cam", "output", "llm", "music", "accounts", "theme"];
  const SUB_KEY = "ribbon.admin.settings.sub";
  function show(sub?: string): void {
    let want = sub;
    if (!want || !SUBS.includes(want)) {
      try { want = localStorage.getItem(SUB_KEY) ?? "mic"; } catch { want = "mic"; }
      if (!SUBS.includes(want)) want = "mic";
    }
    try { localStorage.setItem(SUB_KEY, want); } catch { /* 저장소 없음 */ }
    el.querySelectorAll<HTMLElement>("[data-subpanel]").forEach((p) => { p.hidden = p.dataset.subpanel !== want; });
    if (want === "music") music.show();               // 음악 탭을 열 때마다 새로 읽는다
    if (want === "accounts") accounts.show();
    el.querySelectorAll<HTMLButtonElement>("[data-sub]").forEach((b) => b.classList.toggle("on", b.dataset.sub === want));
  }
  el.querySelectorAll<HTMLButtonElement>("[data-sub]").forEach((b) => { b.onclick = () => ctx.go(`settings/${b.dataset.sub}`); });
  show();
  return { show };
}
