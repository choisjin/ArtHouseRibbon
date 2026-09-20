import type { MicChoice } from "../audio/mic";
import type { DevicesMsg, LLMConfig, MusicConfig, ServerMsg } from "../protocol";
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
 *   음악        : Spotify 앱·계정 연결, 리본이에게 말로 음악 부탁하기, 재생할 곳(TV 화면 / 이 관리자 페이지), 목록, 음량
 *                 (서버 music.py · music_intent.py, 재생 화면 music/player.ts)
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
      <button data-sub="mic">🎙 마이크</button><button data-sub="cam">📷 카메라</button><button data-sub="output">🔈 TV 소리</button><button data-sub="llm">🧠 대화 모델</button><button data-sub="music">🎵 음악</button><button data-sub="playlist">📃 목록</button><button data-sub="theme">🎨 화면</button>
    </div>
    <div class="settings">
      <section class="card" data-subpanel="mic" hidden>
        <h2>🎙 마이크 <small class="hint">이 컴퓨터에서 받기</small></h2>
        <div id="mic" class="agent"></div>
        <p class="hint">무선 마이크 수신기가 꽂힌 컴퓨터(맥미니)에서 이 관리자 페이지를 열어 두세요. 한 번 켜 두면 이 브라우저가 기억해서
          다음에 열 때 자동으로 켭니다. <b>이 창을 닫으면 리본이가 듣지 못합니다.</b> 다른 탭으로 옮겨도 계속 받습니다.</p>
      </section>
      <section class="card" data-subpanel="cam" hidden>
        <h2>📷 카메라 <small class="hint">이 컴퓨터에서 받기</small></h2>
        <div id="cam" class="agent"></div>
        <p class="hint">TV 위에 단 웹캠으로 아이들 얼굴 위치를 찾아 리본이가 그쪽을 바라봅니다. 영상은 저장하거나 보내지 않습니다.
          마이크처럼 한 번 켜 두면 이 브라우저가 기억해서 다음에 열 때 자동으로 켭니다. <b>이 창을 닫으면 리본이가 아이들을 보지 못합니다.</b></p>
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
      <section class="card" data-subpanel="music" hidden>
        <h2>🎵 음악 <small class="hint">Spotify · 리본이에게 말로 부탁하기</small></h2>
        <div id="music" class="agent">
          <div class="row"><b>계정</b><span class="grow"></span><span data-role="account" class="pill">확인 중…</span></div>
          <details data-role="app"><summary class="hint">Spotify 앱 (처음 한 번)</summary>
            <ol class="hint">
              <li><a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> 에서
                앱 만들기 (Web API, Web Playback SDK 체크). 앱 주인이 Premium 이어야 합니다.</li>
              <li>Redirect URI 에 이 주소를 그대로 넣기: <code data-role="redirect"></code> <button data-act="copy">복사</button></li>
              <li>User Management 에 쓸 Spotify 계정 이메일 넣기 (개발 모드는 5명까지)</li>
              <li>Client ID 와 Client Secret 을 아래에 넣고 저장</li>
            </ol>
            <label>Client ID <input name="client_id" spellcheck="false" autocomplete="off" /></label>
            <label>Client Secret <input name="client_secret" type="password" spellcheck="false" autocomplete="off" /></label>
            <div class="actions"><button data-act="app">앱 정보 저장</button></div>
          </details>
          <div class="actions">
            <button data-act="login" class="primary">Spotify 로그인</button>
            <button data-act="logout">연결 끊기</button>
          </div>
          <details><summary class="hint">맥미니가 아닌 컴퓨터에서 로그인했다면</summary>
            <p class="hint">로그인 뒤 "연결할 수 없음" 창이 뜨면 그 창의 주소 전체를 복사해 여기에 붙여 넣으세요.</p>
            <label>주소 <input name="callback_url" spellcheck="false" placeholder="http://127.0.0.1:8765/api/music/callback?code=…" /></label>
            <div class="actions"><button data-act="callback">연결</button></div>
          </details>
          <label class="inline"><input type="checkbox" name="enabled" /> 리본이에게 말로 음악 부탁하기</label>
          <p class="hint">"피카츄 노래 틀어줘", "내 목록 틀어줘", "노래 꺼줘", "다음 노래", "소리 줄여줘", "이 노래 목록에 넣어줘 / 빼줘", "이 노래 뭐야"</p>
          <label>재생할 곳 <select name="output">
            <option value="tv">TV 화면</option>
            <option value="admin">관리자 페이지를 연 컴퓨터 (맥미니)</option>
          </select></label>
          <p class="hint" data-role="device"></p>
          <label>내 목록 <select name="playlist"></select></label>
          <div class="actions">
            <button data-act="new-list">＋ 새 목록 만들기</button>
            <button data-act="reload-lists">목록 다시 읽기</button>
          </div>
          <p class="hint">"내 목록 틀어줘" 로 틀고, "이 노래 넣어줘 / 빼줘" 가 이 목록을 고칩니다. 내가 만든 목록만 고칠 수 있습니다.</p>
          <label>음량 <input name="volume" type="range" min="10" max="100" step="5" /></label>
          <p class="hint">리본이가 말하거나 아이 말을 듣는 동안은 음악 소리를 줄입니다.</p>
          <p class="hint" data-role="now"></p>
          <label>시험 <input name="try" placeholder="피카츄 노래 틀어줘" spellcheck="false" /></label>
          <div class="actions"><button data-act="try">리본이에게 말하듯 보내기</button></div>
          <p class="hint" data-role="result"></p>
        </div>
      </section>
      <section class="card" data-subpanel="playlist" hidden>
        <h2>📃 목록 <small class="hint">곡 넣기·빼기·순서, 검색해서 추가</small></h2>
        <div id="playlist" class="agent">
          <div class="row"><label class="grow">목록 <select name="which"></select></label>
            <button data-act="pl-play" title="설정의 '재생할 곳'에서 틉니다">▶ 목록 틀기</button>
            <button data-act="pl-reload">다시 읽기</button></div>
          <p class="hint" data-role="pl-msg"></p>
          <div class="tracks" data-role="tracks"></div>
          <hr />
          <h3>🔎 노래 찾아서 넣기</h3>
          <div class="row"><input name="q" placeholder="노래 제목이나 가수 (예: 상어가족)" spellcheck="false" class="grow" />
            <button data-act="search" class="primary">검색</button></div>
          <p class="hint">Spotify 는 한 번에 10곡까지 찾아 줍니다.</p>
          <div class="tracks" data-role="results"></div>
        </div>
      </section>
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

  // ---- 음악 (Spotify) ----
  const musicBox = el.querySelector("#music") as HTMLElement;
  const mq = <T extends Element>(s: string) => musicBox.querySelector(s) as T;
  const mAccount = mq<HTMLElement>("[data-role=account]");
  const mDevice = mq<HTMLElement>("[data-role=device]");
  const mNow = mq<HTMLElement>("[data-role=now]");
  const mResult = mq<HTMLElement>("[data-role=result]");
  const mEnabled = mq<HTMLInputElement>("[name=enabled]");
  const mOutput = mq<HTMLSelectElement>("[name=output]");
  const mList = mq<HTMLSelectElement>("[name=playlist]");
  const mVolume = mq<HTMLInputElement>("[name=volume]");
  const mClientId = mq<HTMLInputElement>("[name=client_id]");
  const mSecret = mq<HTMLInputElement>("[name=client_secret]");
  type MusicStatus = { has_app: boolean; client_id: string; connected: boolean; account: { name?: string };
    error: string; redirect_uri: string; devices: string[]; last_error: string };
  let mStatus: MusicStatus | null = null;
  let mCfg: MusicConfig | null = null;
  let listsLoaded = false;
  function renderMusic(): void {
    const s = mStatus;
    if (s) {
      mAccount.className = `pill${s.connected && !s.error ? " ok" : ""}`;
      mAccount.textContent = s.connected ? `연결됨: ${s.account.name ?? ""}${s.error ? " (문제 있음)" : ""}`
        : s.has_app ? "로그인 전" : "앱 정보 없음";
      mq<HTMLElement>("[data-role=redirect]").textContent = s.redirect_uri;
      if (document.activeElement !== mClientId) mClientId.value = s.client_id;
      mSecret.placeholder = s.has_app ? "저장됨 (바꿀 때만 넣기)" : "";
      if (!s.has_app) mq<HTMLDetailsElement>("[data-role=app]").open = true;
      const out = mCfg?.output ?? "tv";
      const where = out === "tv" ? "TV 화면" : "관리자 페이지";
      mDevice.innerHTML = !mCfg?.enabled ? "음악이 꺼져 있습니다."
        : s.devices.includes(out) ? `<span class="ok-text">${where}이 Spotify 스피커로 준비됐습니다.</span>`
        : `<span class="warn-text">${where}이 아직 준비되지 않았습니다. 그 화면을 Chrome 으로 열고 한 번 눌러 주세요.</span>`;
      const err = s.error || s.last_error;
      if (err) mDevice.innerHTML += `<br><span class="warn-text">최근 문제: ${esc(err)}</span>`;
    }
    if (mCfg && !musicBox.contains(document.activeElement)) {
      mEnabled.checked = mCfg.enabled;
      mOutput.value = mCfg.output;
      mVolume.value = String(mCfg.volume);
      if (!listsLoaded) mList.innerHTML = `<option value="${esc(mCfg.playlist_id)}">${esc(mCfg.playlist_title || "(내가 만든 첫 목록)")}</option>`;
      else mList.value = mCfg.playlist_id;
    }
  }
  async function loadMusic(): Promise<void> {
    mStatus = await api<MusicStatus>("GET", "/api/music/status").catch(() => mStatus);
    if (mStatus?.connected && !listsLoaded) {
      type P = { id: string; title: string; count: number | null; mine: boolean };
      const r = await api<{ playlists: P[] }>("GET", "/api/music/playlists")
        .catch((e) => { ctx.msg(`목록을 읽지 못했습니다: ${e}`, true); return null; });
      if (r) {
        listsLoaded = true;
        mList.innerHTML = `<option value="">(내가 만든 첫 목록)</option>` + r.playlists.map((p) =>
          `<option value="${esc(p.id)}" data-title="${esc(p.title)}">${esc(p.title)}${p.count != null ? ` · ${p.count}곡` : ""}${p.mine ? "" : " (남의 목록: 고칠 수 없음)"}</option>`).join("");
      }
    }
    renderMusic();
  }
  async function saveMusic(patch: Partial<MusicConfig>, done: string): Promise<void> {
    try {
      mCfg = await api<MusicConfig>("PUT", "/api/config/music", patch);
      renderMusic();
      if (done) ctx.msg(done);
    } catch (e) { ctx.msg(`저장 실패: ${e}`, true); }
  }
  mEnabled.onchange = () => void saveMusic({ enabled: mEnabled.checked }, mEnabled.checked ? "음악 켬" : "음악 끔");
  mOutput.onchange = () => void saveMusic({ output: mOutput.value as MusicConfig["output"] }, `재생할 곳: ${mOutput.selectedOptions[0]?.textContent}`);
  mList.onchange = () => void saveMusic({ playlist_id: mList.value, playlist_title: mList.selectedOptions[0]?.dataset.title ?? "" }, "내 목록 저장");
  mVolume.onchange = () => void saveMusic({ volume: Number(mVolume.value) }, `음량 ${mVolume.value}`);
  mq<HTMLButtonElement>("[data-act=new-list]").onclick = async () => {
    const name = prompt("새 재생목록 이름", "리본이와 듣는 노래");
    if (!name?.trim()) return;
    try {
      const r = await api<{ playlist: { title: string } }>("POST", "/api/music/playlists", { name: name.trim() });
      listsLoaded = false;                                   // 새 목록까지 다시 읽고, 서버가 이 목록을 '내 목록'으로 정한다
      await loadMusic();
      ctx.msg(`"${r.playlist.title}" 목록을 만들고 내 목록으로 정했습니다`);
    } catch (e) { ctx.msg(`${e}`, true); }
  };
  mq<HTMLButtonElement>("[data-act=reload-lists]").onclick = async () => {
    listsLoaded = false;
    await loadMusic();
    ctx.msg("재생목록을 다시 읽었습니다");
  };
  mq<HTMLButtonElement>("[data-act=copy]").onclick = () => {
    navigator.clipboard?.writeText(mStatus?.redirect_uri ?? "")
      .then(() => ctx.msg("복사했습니다"), () => ctx.msg("복사하지 못했습니다. 직접 골라 복사하세요", true));
  };
  mq<HTMLButtonElement>("[data-act=app]").onclick = async () => {
    try {
      await api("PUT", "/api/music/app", { client_id: mClientId.value, client_secret: mSecret.value });
      mSecret.value = "";
      ctx.msg("앱 정보 저장. 이제 Spotify 로그인을 누르세요");
      await loadMusic();
    } catch (e) { ctx.msg(`${e}`, true); }
  };
  let polling = 0;
  mq<HTMLButtonElement>("[data-act=login]").onclick = () => {
    if (!mStatus?.has_app) { ctx.msg("먼저 Spotify 앱 정보를 저장하세요", true); return; }
    window.open("/api/music/login", "_blank");
    if (!["localhost", "127.0.0.1"].includes(location.hostname)) ctx.msg("로그인 뒤 연결할 수 없다고 나오면 그 창의 주소를 아래 칸에 붙여 넣으세요");
    // 로그인 창에서 돌아올 때까지 연결 상태를 본다 (3분)
    clearInterval(polling);
    const until = Date.now() + 180_000;
    polling = window.setInterval(async () => {
      await loadMusic();
      if (mStatus?.connected || Date.now() > until) {
        clearInterval(polling);
        if (mStatus?.connected) ctx.msg("Spotify 연결됨");
      }
    }, 2000);
  };
  mq<HTMLButtonElement>("[data-act=logout]").onclick = async () => {
    if (!confirm("Spotify 연결을 끊을까요? (앱 정보는 남습니다)")) return;
    await api("DELETE", "/api/music/auth").catch((e) => ctx.msg(`${e}`, true));
    listsLoaded = false;
    await loadMusic();
  };
  mq<HTMLButtonElement>("[data-act=callback]").onclick = async () => {
    const input = mq<HTMLInputElement>("[name=callback_url]");
    try {
      await api("POST", "/api/music/callback_url", { url: input.value });
      input.value = "";
      ctx.msg("Spotify 연결됨");
      await loadMusic();
    } catch (e) { ctx.msg(`${e}`, true); }
  };
  mq<HTMLButtonElement>("[data-act=try]").onclick = async () => {
    const text = mq<HTMLInputElement>("[name=try]").value.trim() || "피카츄 노래 틀어줘";
    mResult.textContent = "보내는 중…";
    type R = { understood: boolean; lines: string[]; error: string };
    const r = await api<R>("POST", "/api/music/command", { text })
      .catch((e) => ({ understood: true, lines: [], error: String(e) }) as R);
    mResult.innerHTML = !r.understood ? "음악 부탁으로 알아듣지 못했습니다 (음악이 꺼져 있거나, 보통 대화로 넘어갈 말)"
      : `리본: <b>${esc(r.lines.join(" "))}</b>${r.error ? `<br><span class="warn-text">${esc(r.error)}</span>` : ""}`;
    void loadMusic();
  };
  ctx.socket.on((m: ServerMsg) => {
    if (m.type !== "music.state") return;
    mNow.textContent = m.track ? `${m.playing ? "▶ 지금" : "❚❚ 멈춤"}: ${m.track.title} · ${m.track.artists}` : "";
  });
  let musicKey = "";
  ctx.onState((st) => {
    const c = st.config?.music;
    if (!c || JSON.stringify(c) === musicKey) return;
    const first = !musicKey;
    musicKey = JSON.stringify(c);
    mCfg = c;
    if (first) void loadMusic(); else renderMusic();
  });
  // 음악 항목을 보는 동안만 장치 준비·계정 상태를 새로 본다
  setInterval(() => { if (musicBox.offsetParent !== null) void loadMusic(); }, 5000);

  // ---- 목록 관리 (Spotify): 곡 빼기·순서·검색해서 넣기 ----
  const plBox = el.querySelector("#playlist") as HTMLElement;
  const pq = <T extends Element>(s: string) => plBox.querySelector(s) as T;
  const plWhich = pq<HTMLSelectElement>("[name=which]");
  const plMsg = pq<HTMLElement>("[data-role=pl-msg]");
  const plRows = pq<HTMLElement>("[data-role=tracks]");
  const plResults = pq<HTMLElement>("[data-role=results]");
  const plQuery = pq<HTMLInputElement>("[name=q]");
  type Track = { uri: string; title: string; artists: string; album_art: string };
  let plTracks: Track[] = [];
  let plListed = false;

  function trackRow(t: Track, n: number | null, buttons: string): string {
    return `<div class="track" data-uri="${esc(t.uri)}">
      ${n === null ? "" : `<b class="t-n">${n}</b>`}
      ${t.album_art ? `<img src="${esc(t.album_art)}" alt="" />` : `<div class="t-art"></div>`}
      <div class="t-text"><b>${esc(t.title)}</b><span>${esc(t.artists)}</span></div>
      <div class="t-btns">${buttons}</div></div>`;
  }
  function renderTracks(): void {
    plRows.innerHTML = !plTracks.length ? `<p class="hint">이 목록에는 아직 노래가 없습니다. 아래에서 찾아 넣어 보세요.</p>`
      : plTracks.map((t, i) => trackRow(t, i + 1,
        `<button data-act="play" title="들어보기">▶</button>
         <button data-act="up" ${i === 0 ? "disabled" : ""} title="위로">▲</button>
         <button data-act="down" ${i === plTracks.length - 1 ? "disabled" : ""} title="아래로">▼</button>
         <button data-act="del" title="목록에서 빼기">✕</button>`)).join("");
  }
  async function plLoadLists(): Promise<void> {
    type P = { id: string; title: string; count: number | null; mine: boolean };
    const r = await api<{ playlists: P[] }>("GET", "/api/music/playlists");
    const mine = r.playlists.filter((p) => p.mine);
    plWhich.innerHTML = mine.map((p) => `<option value="${esc(p.id)}">${esc(p.title)}${p.count != null ? ` · ${p.count}곡` : ""}</option>`).join("");
    const want = mCfg?.playlist_id;
    if (want && mine.some((p) => p.id === want)) plWhich.value = want;
    plListed = true;
  }
  async function plLoad(): Promise<void> {
    if (!mStatus?.connected) { plMsg.innerHTML = `<span class="warn-text">먼저 🎵 음악 탭에서 Spotify 를 연결하세요.</span>`; return; }
    plMsg.textContent = "읽는 중…";
    try {
      if (!plListed) await plLoadLists();
      const r = await api<{ id: string; tracks: Track[] }>("GET", `/api/music/playlist?id=${encodeURIComponent(plWhich.value)}`);
      if (!plWhich.value) plWhich.value = r.id;
      plTracks = r.tracks;
      plMsg.textContent = `${plTracks.length}곡`;
      renderTracks();
    } catch (e) { plMsg.innerHTML = `<span class="warn-text">${esc(String(e))}</span>`; }
  }
  async function plEdit(body: object, done: string): Promise<void> {
    try {
      const r = await api<{ tracks: Track[] }>("POST", "/api/music/playlist/edit", { id: plWhich.value, ...body });
      plTracks = r.tracks;
      plMsg.textContent = `${plTracks.length}곡`;
      renderTracks();
      ctx.msg(done);
    } catch (e) { ctx.msg(`${e}`, true); }
  }
  async function plPlay(uri?: string): Promise<void> {
    try {
      await api("POST", "/api/music/play", uri ? { uri } : { playlist_id: plWhich.value });
      ctx.msg(`${mCfg?.output === "tv" ? "TV" : "이 컴퓨터"}에서 틉니다`);
    } catch (e) { ctx.msg(`${e}`, true); }
  }
  plRows.onclick = (ev) => {
    const btn = (ev.target as HTMLElement).closest("button");
    const row = (ev.target as HTMLElement).closest(".track") as HTMLElement | null;
    if (!btn || !row) return;
    const i = [...plRows.querySelectorAll(".track")].indexOf(row);
    const t = plTracks[i];
    if (btn.dataset.act === "play") void plPlay(t.uri);
    if (btn.dataset.act === "del" && confirm(`"${t.title}" 을(를) 목록에서 뺄까요?`)) void plEdit({ action: "remove", uri: t.uri }, `"${t.title}" 뺐습니다`);
    if (btn.dataset.act === "up") void plEdit({ action: "move", from: i, to: i - 1 }, "위로 옮겼습니다");
    if (btn.dataset.act === "down") void plEdit({ action: "move", from: i, to: i + 1 }, "아래로 옮겼습니다");
  };
  plResults.onclick = (ev) => {
    const btn = (ev.target as HTMLElement).closest("button");
    const row = (ev.target as HTMLElement).closest(".track") as HTMLElement | null;
    if (!btn || !row) return;
    const uri = row.dataset.uri!;
    const title = row.querySelector("b")?.textContent ?? "";
    if (btn.dataset.act === "play") void plPlay(uri);
    if (btn.dataset.act === "add") void plEdit({ action: "add", uri }, `"${title}" 넣었습니다`);
  };
  async function plSearch(): Promise<void> {
    const q = plQuery.value.trim();
    if (!q) return;
    plResults.innerHTML = `<p class="hint">찾는 중…</p>`;
    try {
      const r = await api<{ tracks: Track[] }>("GET", `/api/music/search?q=${encodeURIComponent(q)}`);
      plResults.innerHTML = r.tracks.length
        ? r.tracks.map((t) => trackRow(t, null, `<button data-act="play" title="들어보기">▶</button><button data-act="add" class="primary">＋ 넣기</button>`)).join("")
        : `<p class="hint">찾은 노래가 없습니다.</p>`;
    } catch (e) { plResults.innerHTML = `<p class="hint warn-text">${esc(String(e))}</p>`; }
  }
  pq<HTMLButtonElement>("[data-act=search]").onclick = () => void plSearch();
  plQuery.onkeydown = (ev) => { if (ev.key === "Enter") void plSearch(); };
  plWhich.onchange = () => void plLoad();
  pq<HTMLButtonElement>("[data-act=pl-reload]").onclick = () => { plListed = false; void plLoad(); };
  pq<HTMLButtonElement>("[data-act=pl-play]").onclick = () => void plPlay();

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

  // ---- 작은 탭 (마지막으로 본 것을 기억, 주소는 #settings/mic 처럼) ----
  const SUBS = ["mic", "cam", "output", "llm", "music", "playlist", "theme"];
  const SUB_KEY = "ribbon.admin.settings.sub";
  function show(sub?: string): void {
    let want = sub;
    if (!want || !SUBS.includes(want)) {
      try { want = localStorage.getItem(SUB_KEY) ?? "mic"; } catch { want = "mic"; }
      if (!SUBS.includes(want)) want = "mic";
    }
    try { localStorage.setItem(SUB_KEY, want); } catch { /* 저장소 없음 */ }
    el.querySelectorAll<HTMLElement>("[data-subpanel]").forEach((p) => { p.hidden = p.dataset.subpanel !== want; });
    if (want === "playlist") void loadMusic().then(plLoad);        // 목록 탭을 열 때마다 새로 읽는다
    el.querySelectorAll<HTMLButtonElement>("[data-sub]").forEach((b) => b.classList.toggle("on", b.dataset.sub === want));
  }
  el.querySelectorAll<HTMLButtonElement>("[data-sub]").forEach((b) => { b.onclick = () => ctx.go(`settings/${b.dataset.sub}`); });
  show();
  return { show };
}
