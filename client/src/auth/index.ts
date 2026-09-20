/**
 * 로그인 · 회원가입 화면 (서버 ribbon/auth.py).
 *
 * 모든 화면은 열리기 전에 `requireLogin()` 을 거친다. 아직 아무도 가입하지 않았으면 (needs_setup)
 * "관리자 계정 만들기" 로 나오고, 그렇게 만든 첫 계정이 관리자가 된다. 그 뒤 가입하는 사람은 member 라
 * 관리 화면에는 들어가지 못한다 (관리자가 계정 탭에서 올려 준다).
 */
export interface User { id: string; email: string; name: string; role: "admin" | "member"; created: string }
export interface Me { user: User | null; needs_setup: boolean }

export async function fetchMe(): Promise<Me> {
  try {
    return await fetch("/api/auth/me").then((r) => r.json()) as Me;
  } catch {
    return { user: null, needs_setup: false };
  }
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  location.reload();
}

/** 로그인할 때까지 화면을 잡고 있다가, 끝나면 그 사람을 돌려준다 */
export async function requireLogin(opts: { need?: "admin" | "member"; what?: string } = {}): Promise<User> {
  let me = await fetchMe();
  while (!me.user || (opts.need === "admin" && me.user.role !== "admin")) {
    me = await showForm(me, opts);
  }
  return me.user;
}

function showForm(me: Me, opts: { need?: "admin" | "member"; what?: string }): Promise<Me> {
  const wrongRole = !!me.user && opts.need === "admin" && me.user.role !== "admin";
  const setup = me.needs_setup;
  return new Promise<Me>((resolve) => {
    // 화면 위에 덮개로 띄운다 (TV·관리자 화면의 DOM 을 건드리지 않는다)
    const root = document.createElement("div");
    root.id = "login";
    document.body.appendChild(root);
    root.innerHTML = `
      <style>
        #login { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
          background: #f6f3fa; color: #221c2e; font-family: system-ui, -apple-system, sans-serif; padding: 20px;
          overflow: auto; -webkit-text-size-adjust: 100%; }
        #login .box { width: min(400px, 100%); background: #fff; border: 1px solid #e3dcee; border-radius: 20px; padding: 24px; }
        #login h1 { font-size: 20px; margin: 0 0 4px; }
        #login p.sub { color: #7a7289; font-size: 14px; margin: 0 0 18px; }
        #login label { display: block; font-size: 13px; color: #4d4560; margin: 10px 0 4px; }
        #login input { width: 100%; box-sizing: border-box; padding: 12px; font: inherit; border-radius: 12px;
          border: 1px solid #cfc6dc; background: #fff; color: inherit; }
        #login button { width: 100%; margin-top: 16px; padding: 14px; font: inherit; font-weight: 700; font-size: 16px;
          border: none; border-radius: 14px; background: #7b4bd8; color: #fff; }
        #login button:disabled { opacity: .6; }
        #login .link { display: block; width: 100%; margin-top: 12px; background: none; color: #7b4bd8; font-weight: 600; font-size: 14px; }
        #login .msg { min-height: 20px; margin: 12px 0 0; font-size: 14px; color: #d8453a; }
      </style>
      <form class="box" autocomplete="on">
        <h1>🎀 ${setup ? "관리자 계정 만들기" : wrongRole ? "관리자만 들어갈 수 있어요" : "리본 로그인"}</h1>
        <p class="sub">${setup ? "처음 만드는 계정이 관리자가 됩니다."
          : wrongRole ? `지금은 ${me.user!.name} (일반 회원)으로 로그인돼 있습니다. 관리자 계정으로 다시 로그인하세요.`
          : opts.what ? `${opts.what} 화면을 열려면 로그인하세요.` : "아트하우스 리본"}</p>
        <div data-role="name-row" ${setup ? "" : "hidden"}>
          <label>이름</label><input name="name" autocomplete="name" />
        </div>
        <label>이메일</label><input name="email" type="email" autocomplete="username" />
        <label>비밀번호</label><input name="password" type="password" autocomplete="current-password" />
        <button data-act="go">${setup ? "관리자 계정 만들기" : "로그인"}</button>
        ${setup ? "" : `<button type="button" class="link" data-act="toggle">회원가입</button>`}
        ${wrongRole ? `<button type="button" class="link" data-act="logout">다른 계정으로 로그인</button>` : ""}
        <p class="msg" data-role="msg"></p>
      </form>`;
    const form = root.querySelector("form") as HTMLFormElement;
    const q = <T extends Element>(s: string) => form.querySelector(s) as T;
    const msg = q<HTMLElement>("[data-role=msg]");
    let signup = setup;

    q<HTMLButtonElement>("[data-act=toggle]")?.addEventListener("click", () => {
      signup = !signup;
      q<HTMLElement>("[data-role=name-row]").hidden = !signup;
      q<HTMLElement>("h1").textContent = signup ? "🎀 회원가입" : "🎀 리본 로그인";
      q<HTMLElement>("p.sub").textContent = signup
        ? "가입 뒤 관리자가 권한을 주면 관리 화면도 쓸 수 있습니다." : "아트하우스 리본";
      q<HTMLButtonElement>("[data-act=go]").textContent = signup ? "가입하기" : "로그인";
      q<HTMLButtonElement>("[data-act=toggle]").textContent = signup ? "이미 계정이 있어요" : "회원가입";
      msg.textContent = "";
    });
    q<HTMLButtonElement>("[data-act=logout]")?.addEventListener("click", () => void logout());

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const go = q<HTMLButtonElement>("[data-act=go]");
      const body = {
        email: q<HTMLInputElement>("[name=email]").value.trim(),
        password: q<HTMLInputElement>("[name=password]").value,
        name: q<HTMLInputElement>("[name=name]").value.trim(),
      };
      go.disabled = true;
      msg.textContent = "";
      try {
        const r = await fetch(signup ? "/api/auth/signup" : "/api/auth/login", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        if (!r.ok) {
          const text = await r.text();
          let detail = text;
          try { detail = JSON.parse(text).detail ?? text; } catch { /* 글자 그대로 */ }
          throw new Error(String(detail));
        }
        const done = await r.json() as { user: User };
        if (opts.need === "admin" && done.user.role !== "admin") {
          msg.textContent = "가입됐습니다. 관리자가 권한을 주면 관리 화면을 쓸 수 있어요.";
          go.disabled = false;
          return;
        }
        root.remove();                       // 덮개를 걷고 원래 화면으로
        resolve({ user: done.user, needs_setup: false });
      } catch (e) {
        msg.textContent = String(e).replace(/^Error:\s*/, "");
        go.disabled = false;
      }
    };
  });
}
