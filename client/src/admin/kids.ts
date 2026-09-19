import type { ClassSlot, KidInfo } from "../protocol";
import { mountPromises } from "./promises";
import { ageOf, api, type AdminCtx, DAYS, esc, kidLabel, toMin } from "./shared";

/**
 * 아이들 탭: 아이 추가·수정·삭제. 인적사항(별명·생일·등원 시작일·좋아하는 것·메모)은 리본이 대화에 쓰이고,
 * 정규 수업 시간은 매주 대시보드 시간표에 자동으로 들어간다. 전시실은 '맵' 탭에서 꾸민다.
 */
export function mountKids(el: HTMLElement, ctx: AdminCtx): { select(id: string): void } {
  el.innerHTML = `
    <div class="kids">
      <section class="card kid-list-card">
        <div class="row"><h2>아이들 <small id="kid-count" class="hint"></small></h2><button id="kid-new" class="primary">+ 새 아이</button></div>
        <input id="kid-search" placeholder="이름 찾기" />
        <ul id="kid-list" class="kid-list"></ul>
      </section>
      <section class="card kid-edit">
        <p id="kid-empty" class="hint">왼쪽에서 아이를 고르거나 새 아이를 추가하세요.</p>
        <form id="kid-form" hidden>
          <input type="hidden" name="id" />
          <h2 id="kid-title">새 아이</h2>
          <fieldset><legend>기본 정보</legend>
            <div class="cols">
              <label>이름 <input name="name" required /></label>
              <label>부르는 이름 (별명) <input name="nickname" placeholder="예: 준이" /></label>
              <label>생일 <input name="birthday" type="date" /> <span id="age-out" class="hint"></span></label>
              <label>생일을 모르면 나이 <input name="age" type="number" min="3" max="13" /></label>
              <label>등원 시작일 <input name="start_date" type="date" /></label>
              <label>기본 마이크 <select name="mic_channel"><option value="">없음</option><option value="0">1번</option><option value="1">2번</option><option value="2">3번</option><option value="3">4번</option></select></label>
            </div>
          </fieldset>
          <fieldset><legend>정규 수업 (매주)</legend>
            <div id="slots" class="slots"></div>
            <div class="row"><button type="button" id="slot-add">+ 수업 시간 추가</button>
              <span class="hint">정한 시간이 매주 대시보드 시간표에 들어갑니다. 하루만 바꿀 때는 시간표에서 끌어 옮기세요.</span></div>
          </fieldset>
          <fieldset><legend>대화에 쓰는 정보</legend>
            <label>좋아하는 것 <input name="likes" placeholder="예: 공룡, 분홍색, 고양이 그리기" /></label>
            <label>선생님 메모 <textarea name="memo" rows="3" placeholder="예: 처음엔 수줍어하지만 칭찬하면 말이 많아진다"></textarea></label>
            <p class="hint">리본이가 이 아이와 이야기할 때 참고합니다. 메모는 아이에게 그대로 말하지 않습니다.
              생일이면 축하하고, 별명이 있으면 별명으로 부릅니다.</p>
          </fieldset>
          <fieldset><legend>리본이와의 약속</legend>
            <div id="kid-promises"></div>
            <p class="hint">아이가 대화 중에 지적하거나 하지 말라고 한 것을 리본이가 약속으로 기억해 다음 대화부터 지킵니다.
              잘못 생긴 약속은 지우고, 다른 아이에게도 지킬 것은 "모두에게"로 올리세요.</p>
          </fieldset>
          <div class="actions"><button type="submit" class="primary">저장</button><button type="button" id="kid-delete" class="danger">삭제</button></div>
        </form>
      </section>
    </div>`;
  const $ = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
  const form = $("#kid-form") as HTMLFormElement;
  const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  let selected: KidInfo | null = null;
  const promises = mountPromises($("#kid-promises"), ctx);

  function renderList(): void {
    const q = ($("#kid-search") as HTMLInputElement).value.trim();
    const kids = ctx.kids().filter((k) => !q || k.name.includes(q) || (k.nickname ?? "").includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, "ko"));
    $("#kid-count").textContent = `${ctx.kids().length}명`;
    $("#kid-list").innerHTML = kids.map((k) => {
      const slots = (k.schedule ?? []).map((s) => `${DAYS[s.day]} ${s.start}`).join(", ");
      const age = ageOf(k);
      return `<li data-id="${k.id}" class="${selected?.id === k.id ? "sel" : ""}">
        <b>${esc(kidLabel(k))}</b>${age ? ` <span class="hint">${age}살</span>` : ""}
        <div class="hint">${slots || "정규 수업 없음"}${k.mic_channel != null ? ` · 마이크 ${k.mic_channel + 1}` : ""}</div></li>`;
    }).join("") || `<li class="hint">아이가 없습니다</li>`;
    $("#kid-list").querySelectorAll<HTMLLIElement>("li[data-id]").forEach((li) => {
      li.onclick = () => select(li.dataset.id!);
    });
  }
  ($("#kid-search") as HTMLInputElement).oninput = renderList;

  function slotRow(s: ClassSlot): string {
    return `<div class="slot">
      <select data-f="day">${DAYS.slice(0, 5).map((d, i) => `<option value="${i}" ${s.day === i ? "selected" : ""}>${d}요일</option>`).join("")}</select>
      <input data-f="start" type="time" step="600" value="${s.start}" /> ~ <input data-f="end" type="time" step="600" value="${s.end}" />
      <button type="button" data-f="del" title="지우기">✕</button></div>`;
  }
  function setSlots(slots: ClassSlot[]): void {
    $("#slots").innerHTML = slots.map(slotRow).join("") || `<p class="hint">아직 정규 수업이 없습니다.</p>`;
    $("#slots").querySelectorAll<HTMLButtonElement>("[data-f=del]").forEach((b) => {
      b.onclick = () => { setSlots(readSlots().filter((_, i) => i !== [...$("#slots").querySelectorAll(".slot")].indexOf(b.parentElement!))); };
    });
  }
  function readSlots(): ClassSlot[] {
    return [...$("#slots").querySelectorAll<HTMLElement>(".slot")].map((row) => ({
      day: Number((row.querySelector("[data-f=day]") as HTMLSelectElement).value),
      start: (row.querySelector("[data-f=start]") as HTMLInputElement).value,
      end: (row.querySelector("[data-f=end]") as HTMLInputElement).value,
    }));
  }
  $("#slot-add").onclick = () => {
    const cur = readSlots();
    const prev = cur[cur.length - 1];
    // 같은 시간으로 다음 요일 (보통 주 2~3회 같은 시간이다)
    const next = prev ? { day: Math.min(4, prev.day + 2), start: prev.start, end: prev.end } : { day: 0, start: "15:00", end: "16:30" };
    setSlots([...cur, next]);
  };

  const showAge = () => {
    const b = field("birthday").value;
    const a = b ? ageOf({ birthday: b } as KidInfo) : null;
    $("#age-out").textContent = a != null ? `만 ${a}살` : "";
  };
  field("birthday").oninput = showAge;

  function fill(k: KidInfo | null): void {
    form.hidden = false;
    $("#kid-empty").hidden = true;
    const set = (n: string, v: string) => { field(n).value = v; };
    set("id", k?.id ?? ""); set("name", k?.name ?? ""); set("nickname", k?.nickname ?? "");
    set("birthday", k?.birthday ?? ""); set("age", k?.age != null ? String(k.age) : "");
    set("start_date", k?.start_date ?? ""); set("mic_channel", k?.mic_channel != null ? String(k.mic_channel) : "");
    set("likes", k?.likes ?? ""); set("memo", k?.memo ?? "");
    setSlots(k?.schedule ?? []);
    $("#kid-title").textContent = k ? kidLabel(k) : "새 아이";
    $("#kid-delete").hidden = !k;
    promises.show(k?.id);
    showAge();
  }

  function select(id: string): void {
    selected = ctx.kids().find((k) => k.id === id) ?? null;
    fill(selected);
    renderList();
    if (window.matchMedia("(max-width: 800px)").matches) form.scrollIntoView({ behavior: "smooth" });   // 휴대폰: 목록 아래 폼으로
  }
  $("#kid-new").onclick = () => { selected = null; fill(null); renderList(); field("name").focus(); form.scrollIntoView({ behavior: "smooth" }); };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const slots = readSlots();
    const bad = slots.find((s) => !s.start || !s.end || toMin(s.start) >= toMin(s.end));
    if (bad) { ctx.msg(`${DAYS[bad.day]}요일 수업: 끝나는 시각이 시작보다 늦어야 합니다`, true); return; }
    const v = (n: string) => field(n).value.trim();
    const data = {
      id: v("id") || undefined,
      name: v("name"), nickname: v("nickname"), birthday: v("birthday"), start_date: v("start_date"),
      age: v("age") ? Number(v("age")) : null,
      mic_channel: v("mic_channel") === "" ? null : Number(v("mic_channel")),
      likes: v("likes"), memo: (form.elements.namedItem("memo") as HTMLTextAreaElement).value.trim(),
      schedule: slots,
    };
    try {
      const saved = data.id
        ? await api<KidInfo>("PUT", `/api/kids/${encodeURIComponent(data.id)}`, data)
        : await api<KidInfo>("POST", "/api/kids", data);
      selected = saved;
      field("id").value = saved.id;
      $("#kid-title").textContent = kidLabel(saved);
      $("#kid-delete").hidden = false;
      promises.show(saved.id);
      ctx.msg(`${saved.name} 저장됨`);
    } catch (err) { ctx.msg(String(err), true); }
  };

  $("#kid-delete").onclick = async () => {
    if (!selected || !confirm(`${selected.name} 을(를) 삭제할까요? 시간표와 전시실 배치도 같이 지워집니다.`)) return;
    try {
      await api("DELETE", `/api/kids/${encodeURIComponent(selected.id)}`);
      ctx.msg(`${selected.name} 삭제됨`);
      selected = null;
      form.hidden = true;
      $("#kid-empty").hidden = false;
    } catch (err) { ctx.msg(String(err), true); }
  };

  ctx.onState(() => {
    // 저장하면 서버 state 로 명단이 다시 온다. 고친 폼은 그대로 두고 목록만 새로 그린다
    if (selected) selected = ctx.kids().find((k) => k.id === selected!.id) ?? selected;
    renderList();
  });
  return { select };
}
