import type { KidInfo, ServerMsg, StateMsg } from "../protocol";
import type { Catalog } from "../world/types";
import { fetchSchedule, mountSchedule, type Occurrence } from "./schedule";
import { api, type AdminCtx, esc, kidLabel, toMin, ymd } from "./shared";

/**
 * 대시보드. 작은 탭 두 개:
 *   #dashboard/control   캐릭터 조작 · TV 에 보여줄 방 · 지금 수업 아이들(등원·마이크·호출) · 대화 기록
 *   #dashboard/schedule  수업 시간표
 *
 * 단축키 (대시보드에서, 글자를 입력하는 중이 아닐 때. 휴대폰에서는 버튼으로)
 *   1~4        마이크 1~4번(채널 0~3) 아이 호출
 *   Esc        중단 (지금 하던 말을 멈추고 다음 차례로)
 *   Shift+Esc  모두 멈춤 (기다리는 아이까지 모두 지움)
 *   M          호출 무시 켜기/끄기
 */
const CHANNELS = [0, 1, 2, 3];
const STATE_NAME: Record<string, string> = { idle: "쉬는 중", listening: "듣는 중", thinking: "생각 중", speaking: "말하는 중" };

export function mountDashboard(el: HTMLElement, ctx: AdminCtx, isActive: () => boolean): { show(sub?: string): void } {
  el.innerHTML = `
    <div class="subtabs seg">
      <button data-sub="control">🎮 캐릭터 조작</button><button data-sub="schedule">📅 수업 시간표</button>
    </div>
    <div class="dash" data-subpanel="control">
      <div class="dash-col">
        <section class="card control">
          <h2>캐릭터 조작</h2>
          <div class="status"><span class="dot"></span><b id="ctl-state">-</b><span id="ctl-target" class="hint"></span></div>
          <div class="ctl-buttons">
            <button id="ctl-stop" title="Esc">⏹ 중단 <kbd>Esc</kbd></button>
            <button id="ctl-ignore" title="M">🔔 호출 허용 <kbd>M</kbd></button>
          </div>
        </section>
        <section class="card">
          <h2>TV 에 보여줄 방</h2>
          <div class="seg rooms" id="tv-room"></div>
          <p id="render-info" class="hint"></p>
        </section>
      </div>
      <div class="dash-col">
        <section class="card now">
          <h2 id="now-title">지금 수업</h2>
          <ul id="now-list" class="now-list"></ul>
          <div class="row">
            <select id="now-add"><option value="">+ 수업 외 아이 추가</option></select>
          </div>
        </section>
        <section class="card">
          <h2>🎨 작품</h2>
          <div class="actions">
            <button id="art-shoot" class="primary">📷 작품 촬영</button>
            <button id="art-show">🖼 작품 전시</button>
          </div>
          <p class="hint">촬영하면 고른 아이의 작품으로 서버에 저장됩니다. 전시는 그 아이 전시실을 열어 벽에 겁니다.</p>
          <input id="art-file" type="file" accept="image/*" capture="environment" hidden />
          <div id="art-sent" class="art-thumbs"></div>
        </section>
      </div>
    </div>
    <section class="card sch" data-subpanel="schedule" hidden><div id="sch"></div></section>
    <dialog class="modal" data-role="pick">
      <h3 data-role="pick-title">아이 고르기</h3>
      <button class="x" data-act="pick-close">닫기</button>
      <div class="pick-list" data-role="pick-list"></div>
    </dialog>`;
  const $ = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;

  let today: Occurrence[] = [];
  const extra = new Set<string>();         // 이번에 손으로 추가한 아이 (수업 외)
  let last: StateMsg | null = null;

  mountSchedule($("#sch"), ctx, () => void loadToday());

  // ---- 작은 탭 (마지막으로 본 것을 기억) ----
  const SUB_KEY = "ribbon.admin.dashboard.sub";
  function show(sub?: string): void {
    let want = sub;
    if (want !== "control" && want !== "schedule") {
      try { want = localStorage.getItem(SUB_KEY) ?? "control"; } catch { want = "control"; }
    }
    try { localStorage.setItem(SUB_KEY, want!); } catch { /* 저장소 없음 */ }
    el.querySelectorAll<HTMLElement>("[data-subpanel]").forEach((p) => { p.hidden = p.dataset.subpanel !== want; });
    el.querySelectorAll<HTMLButtonElement>("[data-sub]").forEach((b) => b.classList.toggle("on", b.dataset.sub === want));
  }
  el.querySelectorAll<HTMLButtonElement>("[data-sub]").forEach((b) => { b.onclick = () => ctx.go(`dashboard/${b.dataset.sub}`); });

  // ---- TV 에 보여줄 방 ----
  let rooms: [string, string][] = [];
  async function loadRooms(): Promise<void> {
    try {
      const w = await api<{ catalog: Catalog }>("GET", "/api/world");
      rooms = Object.entries(w.catalog.rooms ?? {}).map(([id, r]) => [id, r.name] as [string, string]);
    } catch (err) { ctx.msg(`방 목록을 못 읽음: ${err}`, true); }
    if (last) renderRooms(last);
  }
  function renderRooms(s: StateMsg): void {
    const w = s.config?.world;
    const box = $("#tv-room");
    box.innerHTML = rooms.map(([id, n]) => `<button data-room="${id}" class="${w?.room === id ? "on" : ""}">${esc(n)}</button>`).join("")
      + (w && !rooms.some(([id]) => id === w.room) ? `<button class="on" disabled>🖼 전시실 보는 중</button>` : "");
    box.querySelectorAll<HTMLButtonElement>("[data-room]").forEach((b) => {
      b.onclick = async () => {
        try { await api("PUT", "/api/world/active", { room: b.dataset.room }); ctx.msg(`TV 방: ${b.textContent}`); }
        catch (err) { ctx.msg(String(err), true); }
      };
    });
    const r = w?.render;
    $("#render-info").textContent = !w ? "" :
      (w.rendering ? `⏳ 배경 렌더 중 (${w.rendering}) · ` : "") +
      (r ? `배경: 블렌더 렌더 ${new Date(r.rendered_at * 1000).toLocaleString()}${r.stale ? " (배치가 바뀌어 다시 렌더 필요)" : ""}`
         : "배경: 렌더 없음 → 실시간 3D");
  }
  void loadRooms();

  async function loadToday(): Promise<void> {
    const d = ymd(new Date());
    try { today = (await fetchSchedule(d, d)).items.filter((o) => !o.cancelled); } catch { today = []; }
    renderNow();
  }

  // ---- 조작 ----
  const send = (m: object) => ctx.socket.sendJson(m);
  const stop = (all: boolean) => { send({ type: "admin.stop", all }); ctx.msg(all ? "모두 멈춤" : "중단"); };
  const toggleIgnore = () => {
    const on = !(last?.ignore_calls ?? false);
    send({ type: "admin.ignore", on });
    ctx.msg(on ? "호출 거부: 아이들이 불러도 대답하지 않습니다" : "호출 허용");
  };
  const wake = (k: KidInfo) => {
    if (k.mic_channel == null) { ctx.msg(`${k.name}에게 마이크를 먼저 정해 주세요`, true); return; }
    send({ type: "admin.wake", kid_id: k.id });
    ctx.msg(`${k.name} 호출`);
  };
  $("#ctl-stop").onclick = () => stop(false);
  $("#ctl-ignore").onclick = toggleIgnore;

  window.addEventListener("keydown", (e) => {
    if (!isActive() || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
    if (e.key === "Escape") { e.preventDefault(); stop(e.shiftKey); return; }
    if (e.key === "m" || e.key === "M" || e.key === "ㅡ") { e.preventDefault(); toggleIgnore(); return; }
    const n = Number(e.key);
    if (n >= 1 && n <= CHANNELS.length) {
      const k = ctx.kids().find((x) => x.mic_channel === n - 1);
      if (k) wake(k); else ctx.msg(`마이크 ${n}번을 쓰는 아이가 없습니다`, true);
      e.preventDefault();
    }
  });

  function renderControl(s: StateMsg): void {
    const kids = s.kids;
    const name = (id: string | null) => { const k = kids.find((x) => x.id === id); return k ? kidLabel(k) : "친구"; };
    $("#ctl-state").textContent = STATE_NAME[s.ribbon] ?? s.ribbon;
    el.querySelector(".status")!.className = `status ${s.ribbon}`;
    $("#ctl-target").textContent = s.target_kid ? ` · ${name(s.target_kid)}` : "";
    const ign = $("#ctl-ignore");
    ign.classList.toggle("on", !!s.ignore_calls);
    ign.innerHTML = s.ignore_calls ? "🔕 호출 거부 <kbd>M</kbd>" : "🔔 호출 허용 <kbd>M</kbd>";
  }

  // ---- 지금 수업 ----
  /** 지금 교실에 있는 아이들 (수업 시간 · 등원 · 손으로 추가한 아이) */
  function nowKids(): KidInfo[] {
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    const ids = new Set([...today.filter((o) => toMin(o.start) - 30 <= m && m < toMin(o.end)).map((o) => o.kid_id),
                         ...ctx.kids().filter((k) => k.present).map((k) => k.id), ...extra]);
    return ctx.kids().filter((k) => ids.has(k.id));
  }

  function renderNow(): void {
    const kids = ctx.kids();
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    const cur = today.filter((o) => toMin(o.start) - 30 <= m && m < toMin(o.end));
    let shown = cur;
    let label = "지금 수업";
    if (!cur.length) {
      const next = today.filter((o) => toMin(o.start) > m).sort((a, b) => toMin(a.start) - toMin(b.start));
      if (next.length) { shown = next.filter((o) => o.start === next[0].start); label = `다음 수업 ${next[0].start}`; }
    }
    $("#now-title").textContent = label;
    const slotOf = new Map(shown.map((o) => [o.kid_id, o]));
    const ids = [...new Set([...shown.map((o) => o.kid_id), ...kids.filter((k) => k.present).map((k) => k.id), ...extra])];
    const rows = ids.map((id) => kids.find((k) => k.id === id)).filter((k): k is KidInfo => !!k);
    const owner = (ch: number) => kids.find((k) => k.mic_channel === ch);
    $("#now-list").innerHTML = rows.length ? rows.map((k) => {
      const o = slotOf.get(k.id);
      const mics = [`<button data-mic="" class="${k.mic_channel == null ? "on" : ""}" title="마이크 없음">–</button>`]
        .concat(CHANNELS.map((c) => {
          const who = owner(c);
          const busy = who && who.id !== k.id;
          return `<button data-mic="${c}" class="${k.mic_channel === c ? "on" : busy ? "busy" : ""}" title="${busy ? `지금 ${esc(who!.name)} 사용 중 (누르면 가져옴)` : `마이크 ${c + 1}`}">${c + 1}</button>`;
        })).join("");
      return `<li data-kid="${k.id}" class="${k.present ? "present" : ""}">
        <div class="who"><b>${esc(kidLabel(k))}</b><span class="hint">${o ? `${o.start}~${o.end}${o.moved ? " (옮김)" : ""}` : "수업 외"}</span></div>
        <button data-act="presence" class="${k.present ? "" : "primary"}">${k.present ? "하원" : "등원"}</button>
        <div class="seg mic" title="마이크">${mics}</div>
        <button data-act="wake" title="이 아이 마이크로 호출">📣</button>
      </li>`;
    }).join("") : `<li class="hint">지금 시간에 수업이 없습니다. 아래에서 아이를 추가할 수 있습니다.</li>`;

    const addSel = $("#now-add") as HTMLSelectElement;
    addSel.innerHTML = `<option value="">+ 수업 외 아이 추가</option>`
      + kids.filter((k) => !ids.includes(k.id)).map((k) => `<option value="${k.id}">${esc(kidLabel(k))}</option>`).join("");

    $("#now-list").querySelectorAll<HTMLLIElement>("li[data-kid]").forEach((li) => {
      const k = kids.find((x) => x.id === li.dataset.kid)!;
      (li.querySelector("[data-act=presence]") as HTMLButtonElement).onclick = () => {
        send({ type: k.present ? "kid.leave" : "kid.enter", kid_id: k.id });
        ctx.msg(k.present ? `${k.name} 하원` : `${k.name} 등원`);
      };
      (li.querySelector("[data-act=wake]") as HTMLButtonElement).onclick = () => wake(k);
      li.querySelectorAll<HTMLButtonElement>("[data-mic]").forEach((b) => {
        b.onclick = async () => {
          const ch = b.dataset.mic === "" ? null : Number(b.dataset.mic);
          if (ch === k.mic_channel) return;
          try {
            await api("PUT", `/api/kids/${encodeURIComponent(k.id)}`, { name: k.name, mic_channel: ch });
            const prev = ch == null ? undefined : owner(ch);
            ctx.msg(ch == null ? `${k.name} 마이크 뺌` : `${k.name} → 마이크 ${ch + 1}${prev && prev.id !== k.id ? ` (${prev.name}는 마이크 없음)` : ""}`);
          } catch (err) { ctx.msg(String(err), true); }
        };
      });
    });
  }
  ($("#now-add") as HTMLSelectElement).onchange = (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v) { extra.add(v); renderNow(); }
  };

  // ---- 작품 촬영 · 전시 (2026-09-21) ----
  // 대화 기록은 '로그' 탭으로 옮겼다 (admin/logs.ts, 서버가 날짜별 파일로 남긴다)
  const file = $("#art-file") as HTMLInputElement;
  const sentBox = $("#art-sent");

  /** 아이 고르기 (고르지 않으면 null). 수업 중인 아이를 위에 보여 준다 */
  const pickDlg = $("[data-role=pick]") as HTMLDialogElement;
  function pickKid(title: string): Promise<KidInfo | null> {
    const all = ctx.kids();
    if (!all.length) { ctx.msg("아이를 먼저 추가하세요", true); return Promise.resolve(null); }
    const here = new Set(nowKids().map((k) => k.id));
    const sorted = [...all].sort((a, b) =>
      Number(here.has(b.id)) - Number(here.has(a.id)) || a.name.localeCompare(b.name, "ko"));
    ($("[data-role=pick-title]") as HTMLElement).textContent = title;
    const list = $("[data-role=pick-list]") as HTMLElement;
    list.innerHTML = sorted.map((k) =>
      `<button data-kid="${esc(k.id)}" class="${here.has(k.id) ? "primary" : ""}">${esc(kidLabel(k))}${here.has(k.id) ? " · 수업 중" : ""}</button>`).join("");
    pickDlg.showModal();
    return new Promise<KidInfo | null>((done) => {
      const finish = (kid: KidInfo | null): void => {
        list.onclick = null;
        pickDlg.onclose = null;
        pickDlg.close();
        done(kid);
      };
      list.onclick = (ev) => {
        const b = (ev.target as HTMLElement).closest("button") as HTMLElement | null;
        if (b?.dataset.kid) finish(all.find((k) => k.id === b.dataset.kid) ?? null);
      };
      pickDlg.onclose = () => finish(null);
    });
  }
  ($("[data-act=pick-close]") as HTMLButtonElement).onclick = () => pickDlg.close();

  $("#art-shoot").onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    const kid = await pickKid("누구 작품인가요?");
    if (!kid) return;
    ctx.msg("사진을 보내는 중…");
    try {
      const url = URL.createObjectURL(f);
      const img = new Image();
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("사진을 열지 못했습니다")); img.src = url; });
      const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const data = c.toDataURL("image/jpeg", 0.88);
      await api("POST", "/api/artworks", {
        data, width: c.width, height: c.height, kid_id: kid.id,
        name: `${kid.name} ${new Date().toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
      });
      const thumb = document.createElement("img");
      thumb.src = data;
      thumb.title = kid.name;
      sentBox.prepend(thumb);
      while (sentBox.children.length > 8) sentBox.lastElementChild!.remove();
      ctx.msg(`${kid.name} 작품을 저장했습니다`);
    } catch (e) { ctx.msg(`보내지 못했습니다: ${e}`, true); }
  };

  $("#art-show").onclick = async () => {
    const kid = await pickKid("누구 전시실을 열까요?");
    if (!kid) return;
    window.open(`/?mode=art&kid=${encodeURIComponent(kid.id)}`, "_blank");
    ctx.msg(`${kid.name} 전시실을 열었습니다`);
  };

  ctx.socket.on((m: ServerMsg) => {
    if (m.type === "ribbon.state" && last) {
      // 상태(듣는 중·말하는 중)는 전체 state 보다 자주 온다
      last = { ...last, ribbon: m.state, target_kid: m.target_kid };
      renderControl(last);
    }
  });

  ctx.onState((s) => {
    last = s;
    renderControl(s);
    renderRooms(s);
    renderNow();
  });
  void loadToday();
  setInterval(() => { if (el.isConnected) void loadToday(); }, 60000);   // 시각이 지나면 "지금 수업"이 바뀐다
  return { show };
}
