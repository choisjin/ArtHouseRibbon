import type { KidInfo } from "../protocol";
import {
  addDays, api, type AdminCtx, DAYS, esc, kidLabel, monday, parseYmd, toHhmm, toMin, weekday, ymd,
} from "./shared";

/**
 * 수업 시간표 (대시보드 왼쪽). 월~금, 15:00~19:00. 일·주·월로 본다.
 * 정규 수업은 아이마다 '아이들' 탭에서 정하고, 여기서 끌어 옮긴 수업은 그날만 바뀐다 (서버 schedule.py).
 * 아이 이름(칩)을 끌어 다른 시각·다른 날로 놓는다. 칩을 누르면 원래대로 / 이날 결석.
 */
export interface Occurrence {
  kid_id: string; date: string; start: string; end: string;
  orig_date: string; orig_start: string; moved: boolean; cancelled: boolean;
}

type View = "day" | "week" | "month";
const SNAP = 10;             // 끌어 놓을 때 시각 단위 (분)
const VIEW_KEY = "ribbon.admin.schedule.view";

export async function fetchSchedule(start: string, end: string): Promise<{ items: Occurrence[]; day_start: string; day_end: string }> {
  return api("GET", `/api/schedule?start=${start}&end=${end}`);
}

export function mountSchedule(el: HTMLElement, ctx: AdminCtx, onChange: () => void): { refresh(): void } {
  let view: View = "week";
  try { view = (localStorage.getItem(VIEW_KEY) as View) || "week"; } catch { /* 저장소 없음 */ }
  let anchor = new Date();
  let items: Occurrence[] = [];
  let dayStart = toMin("15:00"), dayEnd = toMin("19:00");
  let dragging: Occurrence | null = null;

  el.innerHTML = `
    <div class="sch-bar">
      <div class="seg"><button data-nav="-1" title="이전">◀</button><button data-nav="0">오늘</button><button data-nav="1" title="다음">▶</button></div>
      <strong class="sch-title"></strong>
      <div class="seg" role="group">
        <button data-view="day">일</button><button data-view="week">주</button><button data-view="month">월</button>
      </div>
    </div>
    <div class="sch-body"></div>
    <p class="hint">아이 이름을 끌어 옮기면 <b>그날만</b> 바뀝니다 (점선). 이름을 누르면 원래대로 되돌리거나 결석으로 표시합니다.
      매주 수업 시간은 '아이들' 탭에서 정합니다.</p>
    <div class="sch-pop" hidden></div>`;
  const body = el.querySelector(".sch-body") as HTMLElement;
  const title = el.querySelector(".sch-title") as HTMLElement;
  const pop = el.querySelector(".sch-pop") as HTMLElement;

  el.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => {
    b.onclick = () => { view = b.dataset.view as View; try { localStorage.setItem(VIEW_KEY, view); } catch { /* 없음 */ } void load(); };
  });
  el.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach((b) => {
    b.onclick = () => {
      const n = Number(b.dataset.nav);
      if (n === 0) anchor = new Date();
      else if (view === "day") { anchor = addDays(anchor, n); while (weekday(anchor) > 4) anchor = addDays(anchor, n); }
      else if (view === "week") anchor = addDays(anchor, 7 * n);
      else anchor = new Date(anchor.getFullYear(), anchor.getMonth() + n, 1);
      void load();
    };
  });

  /** 보이는 기간 (월~금만) */
  function range(): { from: Date; to: Date } {
    if (view === "day") {
      while (weekday(anchor) > 4) anchor = addDays(anchor, 1);     // 주말이면 다음 월요일
      return { from: anchor, to: anchor };
    }
    if (view === "week") { const m = monday(anchor); return { from: m, to: addDays(m, 4) }; }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return { from: monday(first), to: addDays(monday(last), 4) };
  }

  async function load(): Promise<void> {
    const { from, to } = range();
    try {
      const d = await fetchSchedule(ymd(from), ymd(to));
      items = d.items;
      dayStart = toMin(d.day_start);
      dayEnd = toMin(d.day_end);
    } catch (e) { ctx.msg(`시간표를 못 읽음: ${e}`, true); }
    render();
  }

  const kidOf = (id: string): KidInfo | undefined => ctx.kids().find((k) => k.id === id);

  function chip(o: Occurrence): string {
    const k = kidOf(o.kid_id);
    const i = items.indexOf(o);
    const cls = ["kchip", o.moved ? "moved" : "", o.cancelled ? "cancelled" : "", k?.present ? "present" : ""].join(" ");
    const tip = o.cancelled ? "결석" : o.moved ? `원래 ${o.orig_date.slice(5)} ${o.orig_start}` : "정규 수업";
    return `<span class="${cls}" data-i="${i}" draggable="${!o.cancelled}" title="${esc(tip)}">${esc(k ? kidLabel(k) : "?")}</span>`;
  }

  function render(): void {
    pop.hidden = true;
    el.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    const { from, to } = range();
    if (view === "month") {
      title.textContent = `${anchor.getFullYear()}년 ${anchor.getMonth() + 1}월`;
      renderMonth(from, to);
    } else {
      title.textContent = view === "day"
        ? `${from.getMonth() + 1}월 ${from.getDate()}일 (${DAYS[weekday(from)]})`
        : `${from.getMonth() + 1}월 ${from.getDate()}일 ~ ${to.getMonth() + 1}월 ${to.getDate()}일`;
      renderColumns(from, view === "day" ? 1 : 5);
    }
    bindChips();
  }

  // ---- 일·주: 세로 시간축 ----
  const PX = 1.4;              // 1분에 몇 px
  function renderColumns(from: Date, n: number): void {
    const H = (dayEnd - dayStart) * PX;
    const today = ymd(new Date());
    const days = Array.from({ length: n }, (_, i) => addDays(from, i));
    let times = "";
    for (let m = dayStart; m <= dayEnd; m += 30) {
      times += `<div class="t${m % 60 ? " half" : ""}" style="top:${(m - dayStart) * PX}px">${m % 60 ? "" : toHhmm(m)}</div>`;
    }
    const cols = days.map((d) => {
      const ds = ymd(d);
      const dayItems = items.filter((o) => o.date === ds);
      return `<div class="sch-col${ds === today ? " today" : ""}" data-date="${ds}" style="height:${H}px">
        ${blocks(dayItems, ds)}${ds === today ? nowLine() : ""}<div class="ghost" hidden></div></div>`;
    }).join("");
    const heads = days.map((d) => {
      const ds = ymd(d);
      const n = new Set(items.filter((o) => o.date === ds && !o.cancelled).map((o) => o.kid_id)).size;
      return `<div class="sch-head${ds === today ? " today" : ""}">${DAYS[weekday(d)]} ${d.getMonth() + 1}/${d.getDate()}<small>${n ? ` · ${n}명` : ""}</small></div>`;
    }).join("");
    body.innerHTML = `<div class="sch-week${view === "day" ? " single" : ""}" style="--n:${n}">
      <div></div>${heads}
      <div class="sch-times" style="height:${H}px">${times}</div>${cols}</div>`;
    body.querySelectorAll<HTMLElement>(".sch-col").forEach(bindColumn);
  }

  function nowLine(): string {
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    if (m < dayStart || m > dayEnd) return "";
    return `<div class="now" style="top:${(m - dayStart) * PX}px"></div>`;
  }

  /** 같은 시각의 수업은 한 칸에 모으고, 겹치는 칸은 옆으로 나란히 */
  function blocks(dayItems: Occurrence[], ds: string): string {
    const groups = new Map<string, Occurrence[]>();
    for (const o of dayItems) {
      const key = `${o.start}-${o.end}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(o);
    }
    const list = [...groups.entries()].map(([key, os]) => ({ key, os, s: toMin(os[0].start), e: toMin(os[0].end), lane: 0 }))
      .sort((a, b) => a.s - b.s || a.e - b.e);
    const laneEnds: number[] = [];
    for (const g of list) {
      let lane = laneEnds.findIndex((end) => end <= g.s);
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = g.e;
      g.lane = lane;
    }
    const lanes = Math.max(1, laneEnds.length);
    return list.map((g) => {
      const top = (Math.max(g.s, dayStart) - dayStart) * PX;
      const h = Math.max(22, (Math.min(g.e, dayEnd) - Math.max(g.s, dayStart)) * PX - 2);
      const w = 100 / lanes;
      return `<div class="sch-block" data-date="${ds}" style="top:${top}px;height:${h}px;left:calc(${g.lane * w}% + 2px);width:calc(${w}% - 4px)">
        <div class="bt">${g.key.replace("-", "~")}</div><div class="chips">${g.os.map(chip).join("")}</div></div>`;
    }).join("");
  }

  function dropMinute(col: HTMLElement, clientY: number, len: number): number {
    const y = clientY - col.getBoundingClientRect().top;
    const m = dayStart + Math.round(y / PX / SNAP) * SNAP;
    return Math.min(Math.max(m, dayStart), Math.max(dayStart, dayEnd - len));
  }

  function bindColumn(col: HTMLElement): void {
    const ghost = col.querySelector(".ghost") as HTMLElement;
    col.ondragover = (e) => {
      if (!dragging) return;
      e.preventDefault();
      const len = toMin(dragging.end) - toMin(dragging.start);
      const m = dropMinute(col, e.clientY, len);
      ghost.hidden = false;
      ghost.style.top = `${(m - dayStart) * PX}px`;
      ghost.style.height = `${len * PX}px`;
      ghost.textContent = `${toHhmm(m)}~${toHhmm(m + len)}`;
    };
    col.ondragleave = (e) => { if (!col.contains(e.relatedTarget as Node)) ghost.hidden = true; };
    col.ondrop = (e) => {
      e.preventDefault();
      ghost.hidden = true;
      if (!dragging) return;
      const len = toMin(dragging.end) - toMin(dragging.start);
      void moveTo(dragging, col.dataset.date!, toHhmm(dropMinute(col, e.clientY, len)));
    };
  }

  // ---- 월: 달력 ----
  function renderMonth(from: Date, to: Date): void {
    const today = ymd(new Date());
    let cells = DAYS.slice(0, 5).map((d) => `<div class="mh">${d}</div>`).join("");
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (weekday(d) > 4) continue;
      const ds = ymd(d);
      const other = d.getMonth() !== anchor.getMonth();
      const dayItems = items.filter((o) => o.date === ds);
      const byTime = new Map<string, Occurrence[]>();
      for (const o of dayItems) { if (!byTime.has(o.start)) byTime.set(o.start, []); byTime.get(o.start)!.push(o); }
      const rows = [...byTime.entries()].sort().map(([t, os]) => `<div class="mrow"><b>${t}</b> ${os.map(chip).join("")}</div>`).join("");
      cells += `<div class="mcell${other ? " other" : ""}${ds === today ? " today" : ""}" data-date="${ds}">
        <div class="md">${d.getDate()}</div>${rows}</div>`;
    }
    body.innerHTML = `<div class="sch-month">${cells}</div>`;
    body.querySelectorAll<HTMLElement>(".mcell").forEach((cell) => {
      cell.ondragover = (e) => { if (dragging) { e.preventDefault(); cell.classList.add("over"); } };
      cell.ondragleave = () => cell.classList.remove("over");
      cell.ondrop = (e) => {
        e.preventDefault();
        cell.classList.remove("over");
        if (dragging) void moveTo(dragging, cell.dataset.date!, dragging.start);   // 날짜만 바꾸고 시각은 그대로
      };
    });
  }

  // ---- 칩: 끌기 / 누르기 ----
  function bindChips(): void {
    body.querySelectorAll<HTMLElement>(".kchip").forEach((c) => {
      const o = items[Number(c.dataset.i)];
      c.ondragstart = (e) => {
        dragging = o;
        e.dataTransfer?.setData("text/plain", o.kid_id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        c.classList.add("dragging");
        pop.hidden = true;
      };
      c.ondragend = () => { dragging = null; c.classList.remove("dragging"); body.querySelectorAll<HTMLElement>(".ghost").forEach((g) => { g.hidden = true; }); };
      c.onclick = (e) => { e.stopPropagation(); showPop(o, c); };
    });
  }

  function showPop(o: Occurrence, anchorEl: HTMLElement): void {
    const k = kidOf(o.kid_id);
    const d = parseYmd(o.date);
    pop.innerHTML = `
      <b>${esc(k ? kidLabel(k) : "?")}</b>
      <div class="hint">${d.getMonth() + 1}/${d.getDate()} (${DAYS[weekday(d)]}) ${o.start}~${o.end}${o.cancelled ? " · 결석" : o.moved ? ` · 원래 ${o.orig_date.slice(5)} ${o.orig_start}` : ""}</div>
      <div class="actions">
        ${o.moved || o.cancelled ? `<button data-act="restore">↺ 원래대로</button>` : ""}
        ${o.cancelled ? "" : `<button data-act="cancel" class="danger">이날 결석</button>`}
        <button data-act="kid">아이 정보</button>
        <button data-act="close">닫기</button>
      </div>`;
    const r = anchorEl.getBoundingClientRect(), host = el.getBoundingClientRect();
    pop.style.left = `${Math.min(r.left - host.left, host.width - 240)}px`;
    pop.style.top = `${r.bottom - host.top + 6}px`;
    pop.hidden = false;
    const key = { kid_id: o.kid_id, orig_date: o.orig_date, orig_start: o.orig_start };
    pop.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.onclick = async () => {
        pop.hidden = true;
        try {
          if (b.dataset.act === "restore") { await api("POST", "/api/schedule/restore", key); ctx.msg("원래 수업 시간으로 되돌렸습니다"); }
          else if (b.dataset.act === "cancel") { await api("POST", "/api/schedule/cancel", key); ctx.msg(`${k?.name ?? ""} ${o.date.slice(5)} 결석`); }
          else if (b.dataset.act === "kid") { ctx.go(`kids/${o.kid_id}`); return; }
          else return;
          await load();
          onChange();
        } catch (err) { ctx.msg(String(err), true); }
      };
    });
  }
  document.addEventListener("click", (e) => { if (!pop.contains(e.target as Node)) pop.hidden = true; });

  async function moveTo(o: Occurrence, date: string, start: string): Promise<void> {
    dragging = null;
    if (date === o.date && start === o.start) return;
    try {
      await api("POST", "/api/schedule/move", { kid_id: o.kid_id, orig_date: o.orig_date, orig_start: o.orig_start, date, start });
      const k = kidOf(o.kid_id);
      const back = date === o.orig_date && start === o.orig_start;
      ctx.msg(back ? `${k?.name ?? ""} 원래 시간으로` : `${k?.name ?? ""} ${date.slice(5)} ${start} 로 옮김 (그날만)`);
      await load();
      onChange();
    } catch (err) { ctx.msg(String(err), true); }
  }

  // 아이 명단(정규 수업·출석)이 바뀌면 다시 읽는다. 지금 시각 선은 1분마다
  let kidsKey = "";
  ctx.onState((s) => {
    const key = JSON.stringify(s.kids.map((k) => [k.id, k.name, k.nickname, k.schedule, k.present]));
    if (key === kidsKey) return;
    kidsKey = key;
    void load();
  });
  setInterval(() => { if (view !== "month" && el.isConnected && !dragging) render(); }, 60000);
  return { refresh: () => void load() };
}
