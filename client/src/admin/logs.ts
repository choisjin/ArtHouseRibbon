import type { ServerMsg } from "../protocol";
import { type AdminCtx, api, esc, kidLabel } from "./shared";

/**
 * 관리자 '로그' 탭 (서버 ribbon/chatlog.py). 날짜별로 남은 대화 기록을 본다.
 * 대시보드에 잠깐 보이던 대화와 달리 `data/logs/YYYY-MM-DD.jsonl` 에 남아서 나중에도 볼 수 있다.
 * 오늘 날짜를 보고 있으면 새 말이 들어올 때 바로 이어 붙인다.
 */
interface Row { at: string; kind: string; who: string; text: string }
const KIND_ICON: Record<string, string> = { kid: "🧒", ribbon: "🎀", button: "🔘", memory: "📝" };

export function mountLogs(el: HTMLElement, ctx: AdminCtx): { show(): void } {
  el.innerHTML = `
    <section class="card">
      <div class="row"><h2>📜 대화 로그</h2><span class="grow"></span>
        <label class="inline">날짜 <select name="day"></select></label>
        <button data-act="reload">다시 읽기</button>
      </div>
      <p class="hint" data-role="msg"></p>
      <ul class="talk-log logs" data-role="rows"></ul>
    </section>`;
  const q = <T extends Element>(s: string) => el.querySelector(s) as T;
  const daySel = q<HTMLSelectElement>("[name=day]");
  const rows = q<HTMLElement>("[data-role=rows]");
  const msg = q<HTMLElement>("[data-role=msg]");
  const today = (): string => new Date().toLocaleDateString("sv-SE");   // YYYY-MM-DD

  function line(r: Row): string {
    return `<li class="${esc(r.kind)}"><span class="at">${esc(r.at)}</span>
      <b>${KIND_ICON[r.kind] ?? ""} ${esc(r.who)}</b> ${esc(r.text)}</li>`;
  }

  async function load(day?: string): Promise<void> {
    msg.textContent = "읽는 중…";
    try {
      const days = (await api<{ days: string[] }>("GET", "/api/logs/days")).days;
      const list = days.length ? days : [today()];
      const want = day ?? (daySel.value || list[0]);
      daySel.innerHTML = list.map((d) => `<option value="${d}" ${d === want ? "selected" : ""}>${d}</option>`).join("");
      const r = await api<{ date: string; rows: Row[] }>("GET", `/api/logs?date=${encodeURIComponent(want)}`);
      rows.innerHTML = r.rows.map(line).join("") || `<li class="hint">이 날은 기록이 없습니다.</li>`;
      msg.textContent = `${r.rows.length}줄`;
      rows.scrollTop = rows.scrollHeight;
    } catch (e) { msg.innerHTML = `<span class="warn-text">${esc(String(e))}</span>`; }
  }
  daySel.onchange = () => void load(daySel.value);
  q<HTMLButtonElement>("[data-act=reload]").onclick = () => void load(daySel.value);

  // 오늘을 보고 있으면 새 말이 들어오는 대로 이어 붙인다 (서버가 파일에도 적는다)
  const append = (kind: string, who: string, text: string): void => {
    if (el.offsetParent === null || daySel.value !== today()) return;
    const at = new Date().toLocaleTimeString("ko-KR", { hour12: false });
    rows.insertAdjacentHTML("beforeend", line({ at, kind, who, text }));
    rows.scrollTop = rows.scrollHeight;
  };
  ctx.socket.on((m: ServerMsg) => {
    if (m.type === "transcript") {
      const k = ctx.kids().find((x) => x.id === m.kid_id);
      append("kid", k ? kidLabel(k) : `마이크 ${m.channel + 1}`, m.text);
    } else if (m.type === "speak") {
      append("ribbon", ctx.config()?.ribbon?.name ?? "리본", m.text);
    } else if (m.type === "button") {
      append("button", "호출 버튼", `마이크 ${m.channels.map((c) => c + 1).join(", ")} 듣는 중`);
    } else if (m.type === "memory.changed") {
      const k = ctx.kids().find((x) => x.id === m.kid_id);
      for (const t of m.added) append("memory", "약속", `${t}${k ? ` (${kidLabel(k)})` : ""}`);
      for (const t of m.removed) append("memory", "약속 취소", t);
    }
  });

  return { show(): void { void load(); } };
}
