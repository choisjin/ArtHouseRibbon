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
            <button id="ctl-stop-all" class="danger" title="Shift+Esc">⏏ 모두 멈춤 <kbd>⇧Esc</kbd></button>
            <button id="ctl-ignore" title="M">🔕 호출 무시 <kbd>M</kbd></button>
          </div>
          <ol id="ctl-queue" class="queue"></ol>
          <p class="hint">호출: 아이 줄의 📣 버튼<span class="keys">, 또는 <kbd>1</kbd>~<kbd>4</kbd> (그 마이크를 쓰는 아이)</span>. 중단하면 기다리던 다음 아이 차례로 넘어갑니다.</p>
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
        <section class="card talk">
          <h2>대화</h2>
          <ul id="talk" class="talk-log"></ul>
        </section>
      </div>
    </div>
    <section class="card sch" data-subpanel="schedule" hidden><div id="sch"></div></section>`;
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
    ctx.msg(on ? "호출 무시 켬: 아이들이 불러도 대답하지 않습니다" : "호출 무시 끔");
  };
  const wake = (k: KidInfo) => {
    if (k.mic_channel == null) { ctx.msg(`${k.name}에게 마이크를 먼저 정해 주세요`, true); return; }
    send({ type: "admin.wake", kid_id: k.id });
    ctx.msg(`${k.name} 호출`);
  };
  $("#ctl-stop").onclick = () => stop(false);
  $("#ctl-stop-all").onclick = () => stop(true);
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
    ign.innerHTML = s.ignore_calls ? "🔕 호출 무시 중 <kbd>M</kbd>" : "🔔 호출 받는 중 <kbd>M</kbd>";
    $("#ctl-queue").innerHTML = s.queue.length
      ? s.queue.map((t) => `<li class="${t.state}">${t.position === 0 ? "▶" : `${t.position}.`} ${esc(name(t.kid_id))}
          <span class="hint">${t.position === 0 ? "지금 차례" : "기다리는 중"}${t.text ? ` · "${esc(t.text.slice(0, 30))}"` : ""}</span></li>`).join("")
      : `<li class="hint">기다리는 아이 없음</li>`;
  }

  // ---- 지금 수업 ----
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

  // ---- 대화 기록 ----
  const talk = $("#talk");
  function addTalk(who: string, text: string, cls: string): void {
    const li = document.createElement("li");
    li.className = cls;
    li.innerHTML = `<span class="t">${new Date().toTimeString().slice(0, 5)}</span><b>${esc(who)}</b> ${esc(text)}`;
    talk.prepend(li);
    while (talk.children.length > 40) talk.lastElementChild!.remove();
  }
  ctx.socket.on((m: ServerMsg) => {
    if (m.type === "ribbon.state" && last) {
      // 상태(듣는 중·말하는 중)는 전체 state 보다 자주 온다
      last = { ...last, ribbon: m.state, target_kid: m.target_kid };
      renderControl(last);
      return;
    }
    if (m.type === "transcript") {
      const k = ctx.kids().find((x) => x.id === m.kid_id);
      addTalk(k ? kidLabel(k) : `마이크 ${m.channel + 1}`, m.text, "kid");
    } else if (m.type === "speak") {
      addTalk(ctx.config()?.ribbon?.name ?? "리본", m.text, "ribbon");
    } else if (m.type === "memory.changed") {
      const k = ctx.kids().find((x) => x.id === m.kid_id);
      for (const t of m.added) addTalk("📝 약속", `${t}${k ? ` (${kidLabel(k)})` : ""}`, "ribbon");
      for (const t of m.removed) addTalk("📝 약속 취소", t, "ribbon");
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
