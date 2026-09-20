import type { MusicConfig, MusicStateMsg, ServerMsg } from "../protocol";
import { type AdminCtx, api, esc } from "./shared";

/**
 * 관리자 '설정 → 음악' 탭 (Spotify). 위에서 아래로:
 *   1. 플레이어    지금 나오는 곡 · 앞/재생·멈춤/다음 · 반복 · 섞기 · 음량 · 재생할 곳
 *   2. 내 목록     목록 고르기(리본이가 "내 목록 틀어줘" 로 쓰는 목록) · 새 목록 만들기 · 다시 읽기 · 목록 틀기
 *   3. 곡 목록     고른 목록의 곡: ▶ 들어보기 · ▲▼ 순서 · ✕ 빼기
 *   4. 검색        노래를 찾아 ＋ 로 목록에 넣기
 *   5. 맨 아래     계정·설정 버튼 -> 모달 (Spotify 앱 정보, 로그인, 말로 부탁하기 켜기, 시험 칸)
 * 재생 상태는 서버가 보내 주는 music.state 로 갱신한다 (재생 화면 = TV 또는 이 페이지, music/player.ts).
 */
type Track = { uri: string; title: string; artists: string; album_art: string };
type Status = {
  has_app: boolean; client_id: string; connected: boolean; account: { name?: string };
  error: string; redirect_uri: string; devices: string[]; last_error: string;
};
type Playlist = { id: string; title: string; count: number | null; mine: boolean };
const REPEATS: MusicStateMsg["repeat"][] = ["off", "context", "track"];
const REPEAT_LABEL: Record<string, string> = { off: "반복 없음", context: "목록 반복", track: "한 곡 반복" };

export function mountMusic(el: HTMLElement, ctx: AdminCtx): { show(): void } {
  el.innerHTML = `
    <section class="card">
      <div class="player">
        <img data-role="art" alt="" />
        <div class="p-text">
          <b data-role="title">음악이 나오고 있지 않습니다</b>
          <span data-role="artist"></span>
          <div class="p-prog"><i></i></div>
        </div>
        <div class="p-right">
          <div class="p-src" data-role="src"></div>
          <div class="actions">
            <button data-act="prev" title="앞 노래">◀◀</button>
            <button data-act="toggle" class="primary" title="재생 · 멈춤">▶</button>
            <button data-act="next" title="다음 노래">▶▶</button>
            <button data-act="repeat">반복 없음</button>
            <button data-act="shuffle">순서대로</button>
          </div>
        </div>
      </div>
      <div class="row">
        <label class="inline">음량 <input type="range" name="volume" min="10" max="100" step="5" /></label>
        <label class="inline">재생할 곳 <select name="output">
          <option value="tv">TV 화면 (브라우저)</option>
          <option value="admin">이 컴퓨터 (관리자 페이지)</option>
          <option value="spotify">Spotify 앱이 켜진 기기</option>
        </select></label>
        <label class="inline" data-role="device-row" hidden>기기 <select name="device"></select>
          <button data-act="devices">다시 찾기</button></label>
      </div>
      <p class="hint" data-role="where"></p>
    </section>

    <section class="card">
      <div class="row">
        <label class="grow">내 목록 <select name="which"></select></label>
        <button data-act="pl-play">▶ 목록 틀기</button>
        <button data-act="pl-new">＋ 새 목록</button>
        <button data-act="pl-reload">다시 읽기</button>
      </div>
      <p class="hint">리본이가 "내 목록 틀어줘" 로 트는 목록이고, "이 노래 넣어줘 / 빼줘" 도 이 목록을 고칩니다.</p>
      <p class="hint" data-role="pl-msg"></p>
      <div class="tracks" data-role="tracks"></div>
    </section>

    <section class="card">
      <h3>노래 찾아서 넣기</h3>
      <div class="row">
        <input name="q" class="grow" placeholder="노래 제목이나 가수 (예: 상어가족)" spellcheck="false" />
        <button data-act="search" class="primary">검색</button>
      </div>
      <p class="hint">Spotify 는 한 번에 10곡까지 찾아 줍니다. ▶ 로 먼저 들어 보고 ＋ 로 목록에 넣으세요.</p>
      <div class="tracks" data-role="results"></div>
    </section>

    <div class="actions"><button data-act="open-settings">계정 · 설정</button>
      <span class="hint" data-role="account-line"></span></div>

    <dialog class="modal" data-role="settings">
      <button class="x" data-act="close" aria-label="닫기">✕</button>
      <h3>음악 계정 · 설정</h3>
      <label class="inline"><input type="checkbox" name="enabled" /> 리본이에게 말로 음악 부탁하기</label>
      <p class="hint">"피카츄 노래 틀어줘", "내 목록 틀어줘", "플레이리스트 보여줘", "노래 꺼줘", "다음 노래", "소리 줄여줘",
        "노래 멈춰 / 스포티파이 종료", "이 노래 넣어줘 / 빼줘", "이 노래 뭐야", "반복해줘", "섞어줘"</p>
      <label class="inline">나라 (카탈로그) <select name="market">
        <option value="KR">한국 (KR)</option>
        <option value="US">미국 (US)</option>
        <option value="JP">일본 (JP)</option>
      </select></label>
      <p class="hint">한국 발매판을 먼저 찾습니다. 노래 제목이 영어로만 나오면 한국(KR)인지 확인하세요
        (같은 곡이라도 나라마다 제목이 다릅니다: "상어가족" ↔ "Baby Shark").</p>
      <hr />
      <div class="row"><b>Spotify 계정</b><span class="grow"></span><span data-role="account" class="pill">확인 중…</span></div>
      <div class="actions">
        <button data-act="login" class="primary">Spotify 로그인</button>
        <button data-act="logout">연결 끊기</button>
      </div>
      <details data-role="app"><summary class="hint">Spotify 앱 (처음 한 번)</summary>
        <ol class="hint">
          <li><a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a>
            에서 앱 만들기 (Web API, Web Playback SDK 체크). 앱 주인이 Premium 이어야 합니다.</li>
          <li>Redirect URI 에 이 주소를 그대로 넣기: <code data-role="redirect"></code> <button data-act="copy">복사</button></li>
          <li>User Management 에 쓸 Spotify 계정 이메일 넣기 (개발 모드는 5명까지)</li>
        </ol>
        <label>Client ID <input name="client_id" spellcheck="false" autocomplete="off" /></label>
        <label>Client Secret <input name="client_secret" type="password" spellcheck="false" autocomplete="off" /></label>
        <div class="actions"><button data-act="app">앱 정보 저장</button></div>
      </details>
      <details><summary class="hint">맥미니가 아닌 컴퓨터에서 로그인했다면</summary>
        <p class="hint">로그인 뒤 "연결할 수 없음" 창이 뜨면 그 창의 주소 전체를 복사해 여기에 붙여 넣으세요.</p>
        <label>주소 <input name="callback_url" spellcheck="false" placeholder="http://127.0.0.1:8765/api/music/callback?code=…" /></label>
        <div class="actions"><button data-act="callback">연결</button></div>
      </details>
      <hr />
      <h4>시험</h4>
      <p class="hint">리본이에게 말하듯 넣어 보세요 (리본이는 소리 내어 말하지 않습니다).</p>
      <div class="row"><input name="try" class="grow" placeholder="피카츄 노래 틀어줘" spellcheck="false" />
        <button data-act="try">보내기</button></div>
      <p class="hint" data-role="try-result"></p>
    </dialog>`;

  const q = <T extends Element>(s: string) => el.querySelector(s) as T;
  const dlg = q<HTMLDialogElement>("[data-role=settings]");
  const volume = q<HTMLInputElement>("[name=volume]");
  const output = q<HTMLSelectElement>("[name=output]");
  const deviceRow = q<HTMLElement>("[data-role=device-row]");
  const deviceSel = q<HTMLSelectElement>("[name=device]");
  const which = q<HTMLSelectElement>("[name=which]");
  const plMsg = q<HTMLElement>("[data-role=pl-msg]");
  const rows = q<HTMLElement>("[data-role=tracks]");
  const results = q<HTMLElement>("[data-role=results]");
  const query = q<HTMLInputElement>("[name=q]");

  let cfg: MusicConfig | null = null;
  let status: Status | null = null;
  let now: MusicStateMsg | null = null;
  let nowAt = 0;
  let tracks: Track[] = [];
  let listed = false;

  // ---------- 저장 ----------
  async function save(patch: Partial<MusicConfig>, done = ""): Promise<void> {
    try {
      cfg = await api<MusicConfig>("PUT", "/api/config/music", patch);
      render();
      if (done) ctx.msg(done);
    } catch (e) { ctx.msg(`저장 실패: ${e}`, true); }
  }

  // ---------- Spotify 앱 기기 (Connect): 폰·사운드바처럼 브라우저가 스피커가 못 되는 곳에서 튼다 ----------
  type Device = { id: string; name: string; type: string; active: boolean };
  let devices: Device[] = [];
  let devicesAt = 0;
  async function loadDevices(force = false): Promise<void> {
    if (!status?.connected) return;
    if (!force && Date.now() - devicesAt < 10_000) return;
    devicesAt = Date.now();
    try {
      devices = (await api<{ devices: Device[] }>("GET", "/api/music/devices")).devices;
    } catch (e) { ctx.msg(`기기를 읽지 못했습니다: ${e}`, true); return; }
    const saved = cfg?.device_id ?? "";
    const known = devices.some((d) => d.id === saved);
    deviceSel.innerHTML = devices.map((d) =>
      `<option value="${esc(d.id)}" data-name="${esc(d.name)}">${esc(d.name)} (${esc(d.type)})${d.active ? " · 켜짐" : ""}</option>`).join("")
      + (saved && !known ? `<option value="${esc(saved)}" data-name="${esc(cfg?.device_name ?? "")}">${esc(cfg?.device_name ?? "")} (지금 안 보임)</option>` : "")
      + (devices.length ? "" : `<option value="">(켜진 Spotify 앱이 없습니다)</option>`);
    if (saved) deviceSel.value = saved;
    else if (devices.length) void save({ device_id: devices[0].id, device_name: devices[0].name });
    render();
  }

  // ---------- 플레이어 ----------
  function render(): void {
    if (status) {
      const line = status.connected ? `Spotify: ${status.account.name ?? "연결됨"}` : "Spotify 계정이 연결되지 않았습니다";
      q<HTMLElement>("[data-role=account-line]").textContent = line;
      q<HTMLElement>("[data-role=account]").className = `pill${status.connected && !status.error ? " ok" : ""}`;
      q<HTMLElement>("[data-role=account]").textContent = status.connected
        ? `연결됨: ${status.account.name ?? ""}${status.error ? " (문제 있음)" : ""}`
        : status.has_app ? "로그인 전" : "앱 정보 없음";
      q<HTMLElement>("[data-role=redirect]").textContent = status.redirect_uri;
      const cid = q<HTMLInputElement>("[name=client_id]");
      if (document.activeElement !== cid) cid.value = status.client_id;
      q<HTMLInputElement>("[name=client_secret]").placeholder = status.has_app ? "저장됨 (바꿀 때만 넣기)" : "";
      if (!status.has_app) q<HTMLDetailsElement>("[data-role=app]").open = true;
    }
    if (cfg && !dlg.open) {
      volume.value = String(cfg.volume);
      output.value = cfg.output;
      q<HTMLInputElement>("[name=enabled]").checked = cfg.enabled;
      q<HTMLSelectElement>("[name=market]").value = cfg.market ?? "KR";
    }
    const spotifyDev = cfg?.output === "spotify";
    deviceRow.hidden = !spotifyDev;
    const where = spotifyDev ? (cfg?.device_name || "Spotify 기기")
      : cfg?.output === "admin" ? "관리자 화면을 연 컴퓨터" : "TV 화면";
    const ready = !!cfg?.enabled && (spotifyDev ? !!cfg.device_id : !!status?.devices.includes(cfg!.output));
    // 이 화면이 리모컨(폰)인데 재생할 곳이 "관리자 화면"이면 소리가 날 곳이 없다
    const remoteWarn = !ctx.host && cfg?.output === "admin"
      ? `<br><span class="warn-text">이 화면은 리모컨이라 여기서는 소리가 나지 않습니다. 재생할 곳을 <b>TV 화면</b>으로 두세요.</span>` : "";
    const err = status?.error || status?.last_error;
    q<HTMLElement>("[data-role=where]").innerHTML = !cfg?.enabled
      ? `음악이 꺼져 있습니다. <b>계정 · 설정</b> 에서 켜세요.`
      : (ready
        ? `<span class="ok-text">${esc(where)}${spotifyDev ? " 에서 틉니다." : "이 Spotify 스피커로 준비됐습니다."}</span>`
          + (spotifyDev ? ` 그 기기에서 Spotify 앱을 켜 두세요 (앱이 꺼져 있으면 목록에서 사라집니다).` : "")
        : spotifyDev
          ? `<span class="warn-text">틀 기기를 고르세요.</span> 그 기기에서 Spotify 앱을 한 번 켜면 목록에 나옵니다.`
          : `<span class="warn-text">${where}이 아직 준비되지 않았습니다. 그 화면을 Chrome 으로 열고 한 번 눌러 주세요.</span>`)
        + remoteWarn + (err ? `<br><span class="warn-text">최근 문제: ${esc(err)}</span>` : "");
    renderNow();
  }

  function renderNow(): void {
    const t = now?.track;
    const art = q<HTMLImageElement>("[data-role=art]");
    art.style.visibility = t?.album_art ? "visible" : "hidden";
    if (t?.album_art && art.src !== t.album_art) art.src = t.album_art;
    q<HTMLElement>("[data-role=title]").textContent = t ? t.title : "음악이 나오고 있지 않습니다";
    q<HTMLElement>("[data-role=artist]").textContent = t?.artists ?? "";
    const src = now?.source;
    q<HTMLElement>("[data-role=src]").textContent = !t || !src ? ""
      : src.kind === "playlist" ? `${src.title}` : src.kind === "search" ? "찾은 노래 한 곡"
        : src.kind === "album" ? "앨범" : src.kind === "artist" ? "가수 노래" : "";
    q<HTMLButtonElement>("[data-act=toggle]").textContent = now?.playing ? "❚❚" : "▶";
    const rep = now?.repeat ?? "off";
    const repBtn = q<HTMLButtonElement>("[data-act=repeat]");
    repBtn.textContent = REPEAT_LABEL[rep];
    repBtn.classList.toggle("on", rep !== "off");
    const shBtn = q<HTMLButtonElement>("[data-act=shuffle]");
    shBtn.textContent = now?.shuffle ? "섞기" : "순서대로";
    shBtn.classList.toggle("on", !!now?.shuffle);
    const pos = (now?.position_ms ?? 0) + (now?.playing ? Date.now() - nowAt : 0);
    const pct = t?.duration_ms ? Math.min(100, (pos / t.duration_ms) * 100) : 0;
    (q<HTMLElement>(".p-prog i")).style.width = `${pct}%`;
  }
  setInterval(() => { if (el.offsetParent !== null) renderNow(); }, 1000);

  async function control(action: string, value = ""): Promise<void> {
    try { await api("POST", "/api/music/control", { action, value }); } catch (e) { ctx.msg(`${e}`, true); }
  }
  q<HTMLButtonElement>("[data-act=prev]").onclick = () => void control("prev");
  q<HTMLButtonElement>("[data-act=next]").onclick = () => void control("next");
  q<HTMLButtonElement>("[data-act=toggle]").onclick = () => void control(now?.playing ? "pause" : "resume");
  q<HTMLButtonElement>("[data-act=repeat]").onclick = () => {
    const next = REPEATS[(REPEATS.indexOf(now?.repeat ?? "off") + 1) % REPEATS.length] ?? "off";
    void control("repeat", next);
  };
  q<HTMLButtonElement>("[data-act=shuffle]").onclick = () => void control("shuffle", now?.shuffle ? "off" : "on");
  volume.onchange = () => void save({ volume: Number(volume.value) });
  deviceSel.onchange = () => void save({ device_id: deviceSel.value, device_name: deviceSel.selectedOptions[0]?.dataset.name ?? "" },
    `재생할 기기: ${deviceSel.selectedOptions[0]?.dataset.name ?? ""}`);
  q<HTMLButtonElement>("[data-act=devices]").onclick = () => void loadDevices(true);
  output.onchange = () => {
    void save({ output: output.value as MusicConfig["output"] }, `재생할 곳: ${output.selectedOptions[0]?.textContent}`)
      .then(() => { if (output.value === "spotify") void loadDevices(true); });
  };

  // ---------- 목록 ----------
  function trackRow(t: Track, n: number | null, buttons: string): string {
    return `<div class="track" data-uri="${esc(t.uri)}">
      ${n === null ? "" : `<b class="t-n">${n}</b>`}
      ${t.album_art ? `<img src="${esc(t.album_art)}" alt="" />` : `<div class="t-art"></div>`}
      <div class="t-text"><b>${esc(t.title)}</b><span>${esc(t.artists)}</span></div>
      <div class="t-btns">${buttons}</div></div>`;
  }
  function renderTracks(): void {
    rows.innerHTML = !tracks.length ? `<p class="hint">이 목록에는 아직 노래가 없습니다. 아래에서 찾아 넣어 보세요.</p>`
      : tracks.map((t, i) => trackRow(t, i + 1,
        `<button data-act="play" title="들어보기">▶</button>
         <button data-act="up" ${i === 0 ? "disabled" : ""} title="위로">▲</button>
         <button data-act="down" ${i === tracks.length - 1 ? "disabled" : ""} title="아래로">▼</button>
         <button data-act="del" title="목록에서 빼기">✕</button>`)).join("");
  }
  async function loadPlaylists(): Promise<void> {
    const r = await api<{ playlists: Playlist[] }>("GET", "/api/music/playlists");
    const mine = r.playlists.filter((p) => p.mine);
    which.innerHTML = mine.map((p) =>
      `<option value="${esc(p.id)}" data-title="${esc(p.title)}">${esc(p.title)}${p.count != null ? ` · ${p.count}곡` : ""}</option>`).join("");
    if (cfg?.playlist_id && mine.some((p) => p.id === cfg!.playlist_id)) which.value = cfg.playlist_id;
    listed = true;
  }
  async function loadTracks(): Promise<void> {
    if (!status?.connected) { plMsg.innerHTML = `<span class="warn-text">아래 <b>계정 · 설정</b> 에서 Spotify 를 먼저 연결하세요.</span>`; return; }
    plMsg.textContent = "읽는 중…";
    try {
      if (!listed) await loadPlaylists();
      const r = await api<{ id: string; tracks: Track[] }>("GET", `/api/music/playlist?id=${encodeURIComponent(which.value)}`);
      if (!which.value) which.value = r.id;
      tracks = r.tracks;
      plMsg.textContent = `${tracks.length}곡`;
      renderTracks();
    } catch (e) { plMsg.innerHTML = `<span class="warn-text">${esc(String(e))}</span>`; }
  }
  async function edit(body: object, done: string): Promise<void> {
    try {
      const r = await api<{ tracks: Track[] }>("POST", "/api/music/playlist/edit", { id: which.value, ...body });
      tracks = r.tracks;
      plMsg.textContent = `${tracks.length}곡`;
      renderTracks();
      ctx.msg(done);
    } catch (e) { ctx.msg(`${e}`, true); }
  }
  async function play(uri?: string, title = ""): Promise<void> {
    try {
      await api("POST", "/api/music/play", uri ? { uri, title } : { playlist_id: which.value, title: which.selectedOptions[0]?.dataset.title });
      ctx.msg(`${cfg?.output === "admin" ? "이 컴퓨터" : "TV"}에서 틉니다`);
    } catch (e) { ctx.msg(`${e}`, true); }
  }
  which.onchange = () => {
    // 고른 목록이 곧 리본이가 쓰는 "내 목록"
    void save({ playlist_id: which.value, playlist_title: which.selectedOptions[0]?.dataset.title ?? "" });
    void loadTracks();
  };
  q<HTMLButtonElement>("[data-act=pl-play]").onclick = () => void play();
  q<HTMLButtonElement>("[data-act=pl-reload]").onclick = () => { listed = false; void loadTracks(); };
  q<HTMLButtonElement>("[data-act=pl-new]").onclick = async () => {
    const name = prompt("새 재생목록 이름", "리본이와 듣는 노래");
    if (!name?.trim()) return;
    try {
      const r = await api<{ playlist: { title: string } }>("POST", "/api/music/playlists", { name: name.trim() });
      listed = false;
      await refresh();
      ctx.msg(`"${r.playlist.title}" 목록을 만들고 내 목록으로 정했습니다`);
    } catch (e) { ctx.msg(`${e}`, true); }
  };
  rows.onclick = (ev) => {
    const btn = (ev.target as HTMLElement).closest("button");
    const row = (ev.target as HTMLElement).closest(".track") as HTMLElement | null;
    if (!btn || !row) return;
    const i = [...rows.querySelectorAll(".track")].indexOf(row);
    const t = tracks[i];
    if (btn.dataset.act === "play") void play(t.uri, t.title);
    if (btn.dataset.act === "del" && confirm(`"${t.title}" 을(를) 목록에서 뺄까요?`)) void edit({ action: "remove", uri: t.uri }, `"${t.title}" 뺐습니다`);
    if (btn.dataset.act === "up") void edit({ action: "move", from: i, to: i - 1 }, "위로 옮겼습니다");
    if (btn.dataset.act === "down") void edit({ action: "move", from: i, to: i + 1 }, "아래로 옮겼습니다");
  };

  // ---------- 검색 ----------
  async function search(): Promise<void> {
    const text = query.value.trim();
    if (!text) return;
    results.innerHTML = `<p class="hint">찾는 중…</p>`;
    try {
      const r = await api<{ tracks: Track[] }>("GET", `/api/music/search?q=${encodeURIComponent(text)}`);
      results.innerHTML = r.tracks.length
        ? r.tracks.map((t) => trackRow(t, null, `<button data-act="play" title="들어보기">▶</button><button data-act="add" class="primary">＋ 넣기</button>`)).join("")
        : `<p class="hint">찾은 노래가 없습니다.</p>`;
    } catch (e) { results.innerHTML = `<p class="hint warn-text">${esc(String(e))}</p>`; }
  }
  results.onclick = (ev) => {
    const btn = (ev.target as HTMLElement).closest("button");
    const row = (ev.target as HTMLElement).closest(".track") as HTMLElement | null;
    if (!btn || !row) return;
    const uri = row.dataset.uri!;
    const title = row.querySelector(".t-text b")?.textContent ?? "";
    if (btn.dataset.act === "play") void play(uri, title);
    if (btn.dataset.act === "add") void edit({ action: "add", uri }, `"${title}" 넣었습니다`);
  };
  q<HTMLButtonElement>("[data-act=search]").onclick = () => void search();
  query.onkeydown = (ev) => { if (ev.key === "Enter") void search(); };

  // ---------- 계정 · 설정 모달 ----------
  q<HTMLButtonElement>("[data-act=open-settings]").onclick = () => { void refresh(); dlg.showModal(); };
  q<HTMLButtonElement>("[data-act=close]").onclick = () => dlg.close();
  dlg.addEventListener("close", () => render());
  q<HTMLSelectElement>("[name=market]").onchange = (ev) => {
    void save({ market: (ev.target as HTMLSelectElement).value }, "나라를 바꿨습니다. 다시 검색해 보세요");
  };
  q<HTMLInputElement>("[name=enabled]").onchange = (ev) => {
    const on = (ev.target as HTMLInputElement).checked;
    void save({ enabled: on }, on ? "음악 켬" : "음악 끔");
  };
  q<HTMLButtonElement>("[data-act=copy]").onclick = () => {
    navigator.clipboard?.writeText(status?.redirect_uri ?? "")
      .then(() => ctx.msg("복사했습니다"), () => ctx.msg("복사하지 못했습니다. 직접 골라 복사하세요", true));
  };
  q<HTMLButtonElement>("[data-act=app]").onclick = async () => {
    try {
      await api("PUT", "/api/music/app", {
        client_id: q<HTMLInputElement>("[name=client_id]").value,
        client_secret: q<HTMLInputElement>("[name=client_secret]").value,
      });
      q<HTMLInputElement>("[name=client_secret]").value = "";
      ctx.msg("앱 정보 저장. 이제 Spotify 로그인을 누르세요");
      await refresh();
    } catch (e) { ctx.msg(`${e}`, true); }
  };
  let polling = 0;
  q<HTMLButtonElement>("[data-act=login]").onclick = () => {
    if (!status?.has_app) { ctx.msg("먼저 Spotify 앱 정보를 저장하세요", true); return; }
    window.open("/api/music/login", "_blank");
    if (!["localhost", "127.0.0.1"].includes(location.hostname)) ctx.msg("로그인 뒤 연결할 수 없다고 나오면 그 창의 주소를 모달 아래 칸에 붙여 넣으세요");
    clearInterval(polling);
    const until = Date.now() + 180_000;
    polling = window.setInterval(async () => {
      await refresh();
      if (status?.connected || Date.now() > until) {
        clearInterval(polling);
        if (status?.connected) ctx.msg("Spotify 연결됨");
      }
    }, 2000);
  };
  q<HTMLButtonElement>("[data-act=logout]").onclick = async () => {
    if (!confirm("Spotify 연결을 끊을까요? (앱 정보는 남습니다)")) return;
    await api("DELETE", "/api/music/auth").catch((e) => ctx.msg(`${e}`, true));
    listed = false;
    await refresh();
  };
  q<HTMLButtonElement>("[data-act=callback]").onclick = async () => {
    const input = q<HTMLInputElement>("[name=callback_url]");
    try {
      await api("POST", "/api/music/callback_url", { url: input.value });
      input.value = "";
      ctx.msg("Spotify 연결됨");
      await refresh();
    } catch (e) { ctx.msg(`${e}`, true); }
  };
  q<HTMLButtonElement>("[data-act=try]").onclick = async () => {
    const text = q<HTMLInputElement>("[name=try]").value.trim() || "피카츄 노래 틀어줘";
    const out = q<HTMLElement>("[data-role=try-result]");
    out.textContent = "보내는 중…";
    type R = { understood: boolean; lines: string[]; error: string };
    const r = await api<R>("POST", "/api/music/command", { text })
      .catch((e) => ({ understood: true, lines: [], error: String(e) }) as R);
    out.innerHTML = !r.understood ? "음악 부탁으로 알아듣지 못했습니다 (음악이 꺼져 있거나, 보통 대화로 넘어갈 말)"
      : `리본: <b>${esc(r.lines.join(" "))}</b>${r.error ? `<br><span class="warn-text">${esc(r.error)}</span>` : ""}`;
  };

  // ---------- 상태 받기 ----------
  async function refresh(): Promise<void> {
    status = await api<Status>("GET", "/api/music/status").catch(() => status);
    render();
    if (cfg?.output === "spotify") void loadDevices();      // 폰 앱이 켜졌다 꺼졌다 하므로 가끔 다시 본다
  }
  ctx.socket.on((m: ServerMsg) => {
    if (m.type !== "music.state") return;
    now = m;
    nowAt = Date.now();
    renderNow();
  });
  let key = "";
  ctx.onState((st) => {
    const c = st.config?.music;
    if (!c || JSON.stringify(c) === key) return;
    key = JSON.stringify(c);
    cfg = c;
    render();
  });
  setInterval(() => { if (el.offsetParent !== null) void refresh(); }, 5000);

  return {
    show(): void { void refresh().then(loadTracks); },
  };
}
