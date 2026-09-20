import type { AdminCtx } from "./shared";

/**
 * 관리자 '게임' 탭. 게임 갈래(카테고리)를 목록으로 두고, 그 아래에 놀이 하나씩 둔다.
 * 지금은 포켓몬 맞추기뿐이지만 앞으로 게임을 더 붙일 자리다 (2026-09-21).
 * 누르면 서버가 TV 에서 바로 시작한다 (admin.game -> dialogue.start_quiz(confirm=False)).
 */
interface Game { mode: string; icon: string; name: string; desc: string }
interface Category { id: string; icon: string; name: string; desc: string; games: Game[] }

const CATEGORIES: Category[] = [
  {
    id: "pokemon", icon: "🔴", name: "포켓몬 맞추기", desc: "리본이가 내는 문제를 교실이 같이 맞혀요. 맞히면 다음 문제로 이어집니다.",
    games: [
      { mode: "describe", icon: "🗣", name: "설명 듣고 맞추기", desc: "타입·생김새 설명을 듣고 누구인지 맞혀요" },
      { mode: "image", icon: "🖼", name: "그림 보고 맞추기", desc: "그림을 보고 이름을 맞혀요" },
      { mode: "peek", icon: "🧩", name: "조금 보고 맞추기", desc: "조금만 보이는 그림을 보고 맞혀요" },
    ],
  },
];

export function mountGames(el: HTMLElement, ctx: AdminCtx): { show(): void } {
  el.innerHTML = CATEGORIES.map((c) => `
    <section class="card">
      <div class="row"><h2>${c.icon} ${c.name}</h2><span class="grow"></span>
        <button data-act="stop">■ 게임 끝내기</button></div>
      <p class="hint">${c.desc}</p>
      <ul class="game-list">
        ${c.games.map((g) => `<li data-mode="${g.mode}">
          <span class="g-ic">${g.icon}</span>
          <span class="g-text"><b>${g.name}</b><span class="hint">${g.desc}</span></span>
          <button class="primary" data-act="start">시작</button>
        </li>`).join("")}
      </ul>
    </section>`).join("") + `
    <section class="card">
      <h2>➕ 새 게임</h2>
      <p class="hint">앞으로 만들 게임이 여기에 붙습니다. 만들고 싶은 놀이를 말씀해 주세요.</p>
    </section>`;

  el.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("button");
    if (!btn) return;
    if (btn.dataset.act === "stop") {
      ctx.socket.sendJson({ type: "admin.game", action: "stop" });
      ctx.msg("게임을 끝냈습니다");
      return;
    }
    const li = btn.closest("li") as HTMLElement | null;
    if (btn.dataset.act === "start" && li?.dataset.mode) {
      ctx.socket.sendJson({ type: "admin.game", mode: li.dataset.mode });
      ctx.msg(`${li.querySelector("b")?.textContent} 시작`);
    }
  });

  return { show(): void { /* 지금은 따로 읽어 올 것이 없다 */ } };
}
