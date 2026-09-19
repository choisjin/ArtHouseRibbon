import type { GameView } from "../protocol";

/**
 * 포켓몬 맞추기 게임 화면 (서버 games/pokemon_quiz.py 의 view).
 *   그림 카드: 그림 보고 맞추기 = 그림 전체 / 가린 그림 = 6x6 칸 중 shown 만 보임 / 설명 듣고 = "?" 카드와 타입
 *   이름판: 글자 수(빈칸) -> 초성 -> 한 글자씩. 맞추면 이름과 그림 전체
 */
export class GameBoard {
  private el: HTMLElement;
  private img: HTMLImageElement;
  private mask: HTMLElement;
  private cells: HTMLElement[] = [];
  private grid = 0;
  private src = "";

  constructor() {
    this.el = document.createElement("div");
    this.el.id = "game";
    this.el.className = "overlay";
    this.el.innerHTML = `
      <div class="g-title"></div>
      <div class="g-card"><img alt="" /><div class="g-mask"></div><div class="g-q">?</div></div>
      <div class="g-types"></div>
      <div class="g-board"></div>
      <div class="g-answer"></div>`;
    document.body.appendChild(this.el);
    this.img = this.el.querySelector("img")!;
    this.mask = this.el.querySelector(".g-mask")!;
  }

  render(v: GameView | null): void {
    this.el.style.display = v ? "flex" : "none";
    if (!v) { this.src = ""; this.img.removeAttribute("src"); return; }
    const title = { describe: "설명 듣고 맞추기", image: "그림 보고 맞추기", peek: "가린 그림 맞추기" }[v.mode] ?? "";
    (this.el.querySelector(".g-title") as HTMLElement).textContent = `포켓몬 ${title}`;

    // 가린 칸을 먼저 깔고 그림을 바꾼다 (새 그림이 한 순간이라도 다 보이지 않게)
    if (this.grid !== v.grid) {
      this.grid = v.grid;
      this.mask.style.gridTemplateColumns = `repeat(${v.grid}, 1fr)`;
      this.mask.innerHTML = "";
      this.cells = Array.from({ length: v.grid * v.grid }, () => {
        const c = document.createElement("div");
        this.mask.appendChild(c);
        return c;
      });
    }
    const shown = v.shown ? new Set(v.shown) : null;
    this.mask.style.display = shown ? "grid" : "none";
    this.cells.forEach((c, i) => c.classList.toggle("open", !shown || shown.has(i)));

    const card = this.el.querySelector(".g-card") as HTMLElement;
    card.classList.toggle("noimg", !v.image);
    card.classList.toggle("solved", v.solved);
    if (v.image && v.image !== this.src) { this.src = v.image; this.img.src = v.image; }
    if (!v.image) { this.src = ""; this.img.removeAttribute("src"); }

    (this.el.querySelector(".g-types") as HTMLElement).innerHTML =
      v.types.map((t) => `<span>${t}</span>`).join("");
    (this.el.querySelector(".g-board") as HTMLElement).innerHTML =
      v.board.map((b) => `<span class="${b.k}">${b.c || "&nbsp;"}</span>`).join("");
    (this.el.querySelector(".g-answer") as HTMLElement).textContent = v.solved && v.answer ? `정답: ${v.answer}` : "";
  }
}
