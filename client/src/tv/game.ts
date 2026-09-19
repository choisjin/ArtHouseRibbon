import type { GameMenuView, GameMode, GameView } from "../protocol";

/** 표지 그림 위 장식 (MLX 표지가 없을 때): 설명 듣고 = ? 말풍선, 그림 보고 = 금색 액자, 조금 보고 = 거의 다 덮은 타일 */
const PEEK_OPEN = new Set([8, 15, 21, 26]);
function decoration(mode: GameMode): string {
  if (mode === "describe") return `<div class="gm-bubble">?</div>`;
  if (mode === "image") return `<div class="gm-frame"></div>`;
  return `<div class="gm-tiles">${Array.from({ length: 36 }, (_, i) => `<i class="${PEEK_OPEN.has(i) ? "open" : ""}"></i>`).join("")}</div>`;
}

/**
 * 포켓몬 맞추기 게임 화면 (서버 games/pokemon_quiz.py 의 view).
 *   그림 카드: 그림 보고 맞추기 = 그림 전체 / 조금 보고 맞추기 = 6x6 칸 중 shown 만 보임 / 설명 듣고 = "?" 카드와 타입
 *   이름판: 글자 수(빈칸) -> 초성 -> 한 글자씩. 맞추면 이름과 그림 전체
 *   고르기 화면: 게임 박스 표지 같은 카드 3장. MLX 로 만든 표지(thumb)가 있으면 그걸 깔고, 없으면 게임마다 다른 색 배경 +
 *   빛줄기 + 포켓몬 공식 그림 + 장식으로 꾸민다. 제목은 굵은 테두리 글씨로 표지 위에. 고른 카드는 반짝이고 나머지는 흐려진다
 */
export class GameBoard {
  private el: HTMLElement;
  private img: HTMLImageElement;
  private mask: HTMLElement;
  private cells: HTMLElement[] = [];
  private grid = 0;
  private src = "";
  private menu: HTMLElement;

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
    this.menu = document.createElement("div");
    this.menu.id = "game-menu";
    this.menu.className = "overlay";
    document.body.appendChild(this.menu);
    this.img = this.el.querySelector("img")!;
    this.mask = this.el.querySelector(".g-mask")!;
  }

  render(v: GameView | null): void {
    this.renderMenu(v?.kind === "menu" ? v : null);
    const play = v?.kind === "play" ? v : null;
    this.el.style.display = play ? "flex" : "none";
    if (!play) { this.src = ""; this.img.removeAttribute("src"); return; }
    this.renderPlay(play);
  }

  private menuKey = "";

  private renderMenu(v: GameMenuView | null): void {
    this.menu.style.display = v ? "flex" : "none";
    if (!v) { this.menuKey = ""; return; }
    const key = v.items.map((i) => `${i.mode}:${i.thumb}:${i.title}`).join();
    if (key !== this.menuKey) {                     // 카드는 한 번만 만들고, 고르면 반짝이는 것만 바꾼다
      this.menuKey = key;
      this.menu.innerHTML = `
        <div class="gm-title">포켓몬 맞추기</div>
        <div class="gm-cards">${v.items.map((i) => `
          <div class="gm-card" data-mode="${i.mode}">
            <div class="gm-cover gm-${i.mode}">
              ${i.thumb ? `<img class="gm-full" alt="" src="${i.thumb}" />`
                : `<div class="gm-rays"></div><img class="gm-art" alt="" src="${i.art}" />${decoration(i.mode)}`}
              <div class="gm-logo"><small>포켓몬</small><b>${i.title}</b></div>
            </div>
            <div class="gm-num">${i.num}</div>
            <div class="gm-sub">${i.sub}</div>
          </div>`).join("")}
        </div>
        <div class="gm-hint"></div>`;

    }
    this.menu.classList.toggle("picked", !!v.selected);
    this.menu.querySelectorAll<HTMLElement>(".gm-card").forEach((c) => c.classList.toggle("on", c.dataset.mode === v.selected));
    (this.menu.querySelector(".gm-hint") as HTMLElement).textContent = v.selected
      ? "이걸로 할까? \"응\" 하면 시작!" : "번호나 게임 이름을 말해 줘!";
  }

  private renderPlay(v: Extract<GameView, { kind: "play" }>): void {
    const title = { describe: "설명 듣고 맞추기", image: "그림 보고 맞추기", peek: "조금 보고 맞추기" }[v.mode] ?? "";
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
