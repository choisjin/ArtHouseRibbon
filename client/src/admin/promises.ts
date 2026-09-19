import type { MemoryRule, ServerMsg } from "../protocol";
import { api, type AdminCtx, esc } from "./shared";

/**
 * 리본이가 기억하는 약속 목록 (서버 memory.py). 아이가 대화 중에 지적하거나 하지 말라고 한 것이 저절로 쌓이고,
 * 선생님이 직접 적거나 지우거나 모든 아이 공통으로 올릴 수 있다.
 *   아이들 탭: 그 아이와 한 약속 (show(kidId))
 *   캐릭터 탭: 모든 아이와 한 약속 (show(null))
 */
export function mountPromises(el: HTMLElement, ctx: AdminCtx): { show(kidId: string | null | undefined): void } {
  let kid: string | null | undefined;   // undefined = 아직 안 고름 (새 아이)

  el.innerHTML = `
    <ul class="promises"></ul>
    <div class="row"><input class="grow" maxlength="60" placeholder="예: 공룡 이야기를 먼저 꺼내지 않는다." />
      <button type="button" data-add>약속 추가</button></div>`;
  const list = el.querySelector("ul") as HTMLUListElement;
  const input = el.querySelector("input") as HTMLInputElement;

  async function reload(): Promise<void> {
    if (kid === undefined) { list.innerHTML = `<li class="hint">아이를 저장하면 약속을 적을 수 있습니다.</li>`; return; }
    const url = kid ? `/api/memory?kid_id=${encodeURIComponent(kid)}` : "/api/memory?common=true";
    let rules: MemoryRule[] = [];
    try { rules = await api<MemoryRule[]>("GET", url); } catch (err) { ctx.msg(String(err), true); return; }
    list.innerHTML = rules.length ? rules.map((r) => `<li>
        <span class="grow">${esc(r.text)}
          <small class="hint">${r.by === "admin" ? "선생님이 적음" : `아이 말: "${esc(r.source)}"`} · ${esc(r.created.slice(0, 10))}</small></span>
        ${kid ? `<button type="button" data-common="${r.id}" title="모든 아이와의 약속으로 올리기">모두에게</button>` : ""}
        <button type="button" class="danger" data-del="${r.id}">지우기</button></li>`).join("")
      : `<li class="hint">아직 약속이 없습니다. ${kid ? "아이가 대화 중에 \"그만해\", \"그렇게 부르지 마\" 처럼 말하면 저절로 생깁니다." : ""}</li>`;
    list.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) => {
      b.onclick = async () => {
        try { await api("DELETE", `/api/memory/${b.dataset.del}`); await reload(); } catch (err) { ctx.msg(String(err), true); }
      };
    });
    list.querySelectorAll<HTMLButtonElement>("[data-common]").forEach((b) => {
      b.onclick = async () => {
        try {
          await api("PUT", `/api/memory/${b.dataset.common}`, { kid_id: null });
          ctx.msg("모든 아이와의 약속으로 올렸습니다 (캐릭터 탭)");
          await reload();
        } catch (err) { ctx.msg(String(err), true); }
      };
    });
  }

  (el.querySelector("[data-add]") as HTMLButtonElement).onclick = async () => {
    const text = input.value.trim();
    if (!text || kid === undefined) return;
    try {
      await api("POST", "/api/memory", { text, kid_id: kid });
      input.value = "";
      await reload();
    } catch (err) { ctx.msg(String(err), true); }
  };
  input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); (el.querySelector("[data-add]") as HTMLButtonElement).click(); } };

  ctx.socket.on((m: ServerMsg) => {
    if (m.type === "memory.changed" && kid && m.kid_id === kid && el.isConnected) void reload();
  });

  return { show(id: string | null | undefined) { kid = id; void reload(); } };
}
