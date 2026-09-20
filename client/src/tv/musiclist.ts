import type { MusicListView } from "../protocol";

/**
 * "플레이리스트 보여줘" 로 TV 에 띄우는 번호 목록 (서버 music_intent.MusicControl.list_view).
 * 아이가 번호를 말하면 그 노래를 목록에서 뺀다. 한 쪽에 6곡, "다음" 으로 넘긴다.
 * 큰 번호를 왼쪽에 크게 두어 아직 글을 못 읽는 아이도 번호를 말할 수 있게 한다.
 */
export class MusicList {
  private el: HTMLElement;

  constructor() {
    this.el = document.createElement("div");
    this.el.id = "music-list";
    this.el.className = "overlay";
    document.body.appendChild(this.el);
  }

  render(view: MusicListView | null): void {
    if (!view) {
      this.el.classList.remove("on");
      this.el.innerHTML = "";
      return;
    }
    const rows = view.items.map((it) => `
      <div class="ml-row">
        <b class="ml-n">${it.n}</b>
        ${it.art ? `<img src="${it.art}" alt="" />` : `<div class="ml-art"></div>`}
        <div class="ml-text"><b>${esc(it.title)}</b><span>${esc(it.artists)}</span></div>
      </div>`).join("");
    const what = view.kind === "search" ? "번호를 말하면 틀어요" : "번호를 말하면 목록에서 빼요";
    this.el.innerHTML = `
      <div class="ml-head">${view.kind === "search" ? "🔎 " : "📃 "}${esc(view.title)}
        <small>${view.total}곡${view.pages > 1 ? ` · ${view.page}/${view.pages}쪽` : ""}</small></div>
      ${rows}
      <div class="ml-foot">${what}${view.page < view.pages ? ` · "다음" 이라고 하면 더 보여요` : ""}</div>`;
    this.el.classList.add("on");
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
