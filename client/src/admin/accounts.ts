import type { User } from "../auth/index";
import { type AdminCtx, api, esc } from "./shared";

/**
 * 관리자 '설정 → 계정' 탭 (서버 ribbon/auth.py).
 *   - 가입한 사람 목록, 권한 올리기(admin)·내리기(member)·지우기
 *   - 내 비밀번호 바꾸기
 * 첫 가입자는 자동으로 관리자다. 그 뒤 가입한 사람은 member 라 관리 화면에 들어오지 못하므로
 * 여기서 권한을 줘야 한다. 관리자가 한 명뿐이면 내리거나 지울 수 없다 (문이 잠기는 것을 막는다).
 */
const ROLE_NAME: Record<string, string> = { admin: "관리자", member: "일반" };

export function mountAccounts(el: HTMLElement, ctx: AdminCtx): { show(): void } {
  el.innerHTML = `
    <section class="card">
      <h2>계정 <small class="hint">누가 관리 화면에 들어올 수 있는지</small></h2>
      <p class="hint">관리자는 모든 화면을 쓸 수 있고, 일반 회원은 작품 찍어 보내기와 보기만 할 수 있습니다.
        새로 가입한 사람은 일반 회원으로 시작합니다.</p>
      <div data-role="list" class="accounts"></div>
      <p class="hint" data-role="msg"></p>
    </section>
    <section class="card">
      <h3>내 비밀번호 바꾸기</h3>
      <label>지금 비밀번호 <input name="current" type="password" autocomplete="current-password" /></label>
      <label>새 비밀번호 (8자 이상) <input name="next" type="password" autocomplete="new-password" /></label>
      <div class="actions"><button data-act="password">바꾸기</button></div>
    </section>`;
  const q = <T extends Element>(s: string) => el.querySelector(s) as T;
  const list = q<HTMLElement>("[data-role=list]");
  const msg = q<HTMLElement>("[data-role=msg]");
  let me: User | null = null;

  async function load(): Promise<void> {
    try {
      const [meRes, users] = await Promise.all([
        fetch("/api/auth/me").then((r) => r.json()) as Promise<{ user: User | null }>,
        api<{ users: User[] }>("GET", "/api/auth/users"),
      ]);
      me = meRes.user;
      list.innerHTML = users.users.map((u) => `
        <div class="account" data-id="${esc(u.id)}">
          <div class="a-text">
            <b>${esc(u.name)}${u.id === me?.id ? " (나)" : ""}</b>
            <span>${esc(u.email)} · 가입 ${esc(u.created.slice(0, 10))}</span>
          </div>
          <span class="pill${u.role === "admin" ? " ok" : ""}">${ROLE_NAME[u.role] ?? u.role}</span>
          <div class="actions">
            ${u.role === "admin"
              ? `<button data-act="member" ${u.id === me?.id ? "disabled" : ""}>일반으로</button>`
              : `<button data-act="admin" class="primary">관리자로</button>`}
            <button data-act="del" ${u.id === me?.id ? "disabled" : ""}>지우기</button>
          </div>
        </div>`).join("");
      msg.textContent = `${users.users.length}명`;
    } catch (e) {
      msg.innerHTML = `<span class="warn-text">${esc(String(e))}</span>`;
    }
  }

  list.onclick = async (ev) => {
    const btn = (ev.target as HTMLElement).closest("button");
    const row = (ev.target as HTMLElement).closest(".account") as HTMLElement | null;
    if (!btn || !row) return;
    const id = row.dataset.id!;
    const name = row.querySelector("b")?.textContent ?? "";
    try {
      if (btn.dataset.act === "del") {
        if (!confirm(`${name} 계정을 지울까요? 다시 가입해야 들어올 수 있습니다.`)) return;
        await api("DELETE", `/api/auth/users/${encodeURIComponent(id)}`);
        ctx.msg(`${name} 계정을 지웠습니다`);
      } else {
        const role = btn.dataset.act === "admin" ? "admin" : "member";
        if (role === "admin" && !confirm(`${name} 님에게 관리자 권한을 줄까요? 모든 설정을 바꿀 수 있게 됩니다.`)) return;
        await api("PUT", `/api/auth/users/${encodeURIComponent(id)}`, { role });
        ctx.msg(`${name} → ${ROLE_NAME[role]}`);
      }
      await load();
    } catch (e) { ctx.msg(`${e}`, true); }
  };

  q<HTMLButtonElement>("[data-act=password]").onclick = async () => {
    const cur = q<HTMLInputElement>("[name=current]");
    const next = q<HTMLInputElement>("[name=next]");
    try {
      await api("POST", "/api/auth/password", { current: cur.value, password: next.value });
      cur.value = next.value = "";
      ctx.msg("비밀번호를 바꿨습니다");
    } catch (e) { ctx.msg(`${e}`, true); }
  };

  return { show(): void { void load(); } };
}
