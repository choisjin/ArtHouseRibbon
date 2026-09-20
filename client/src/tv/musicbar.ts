import type { MusicStateMsg } from "../protocol";

/**
 * TV 아래 음악 상태바: 앨범 그림 · 곡 제목 · 가수 · 흐르는 진행 막대 · 재생/멈춤.
 * 재생 화면(music/player.ts)이 알린 상태를 서버가 music.state 로 보내 준다.
 * 멈춘 뒤 1분이 지나면 내린다. 떠 있는 동안은 자막을 조금 위로 올린다 (body.music-on).
 */
const HIDE_PAUSED_MS = 60_000;

export class MusicBar {
  private el: HTMLElement;
  private state: MusicStateMsg | null = null;
  private at = 0;                    // 상태를 받은 때 (진행 막대를 흘려 보인다)

  constructor() {
    this.el = document.createElement("div");
    this.el.id = "music-bar";
    this.el.className = "overlay";
    this.el.innerHTML = `<img alt="" /><div class="mb-text"><b></b><span></span>
      <div class="mb-prog"><i></i></div></div>
      <div class="mb-side"><div class="mb-src"></div><div class="mb-modes"></div></div>
      <div class="mb-icon"></div>`;
    document.body.appendChild(this.el);
    setInterval(() => this.tick(), 500);
  }

  render(m: MusicStateMsg): void {
    this.state = m;
    this.at = performance.now();
    const t = m.track;
    if (t) {
      const img = this.el.querySelector("img") as HTMLImageElement;
      if (img.src !== t.album_art) img.src = t.album_art;
      img.style.visibility = t.album_art ? "visible" : "hidden";
      (this.el.querySelector("b") as HTMLElement).textContent = t.title;
      (this.el.querySelector(".mb-text span") as HTMLElement).textContent = t.artists;
    }
    // 무엇을 틀고 있나: 검색해서 튼 한 곡이면 , 재생목록이면 와 목록 이름
    const src = m.source;
    const srcEl = this.el.querySelector(".mb-src") as HTMLElement;
    srcEl.textContent = !src ? "" : src.kind === "playlist" ? `${src.title}`
      : src.kind === "search" ? "찾은 노래 한 곡" : src.kind === "album" ? "앨범"
      : src.kind === "artist" ? "가수 노래" : "";
    // 반복·섞기 (Spotify 앱에서 바꿔도 여기에 그대로 보인다)
    const repeat = m.repeat ?? "off";
    (this.el.querySelector(".mb-modes") as HTMLElement).innerHTML =
      `<span class="${repeat === "off" ? "off" : ""}">${repeat === "track" ? "한 곡 반복" : repeat === "context" ? "목록 반복" : "반복 없음"}</span>` +
      `<span class="${m.shuffle ? "" : "off"}">${m.shuffle ? "섞기" : "순서대로"}</span>`;
    (this.el.querySelector(".mb-icon") as HTMLElement).textContent = m.playing ? "♪" : "❚❚";
    this.el.classList.toggle("paused", !m.playing);
    this.tick();
  }

  private tick(): void {
    const m = this.state;
    const since = performance.now() - this.at;
    const show = !!m?.track && (m.playing || since < HIDE_PAUSED_MS);
    this.el.classList.toggle("on", show);
    document.body.classList.toggle("music-on", show);
    if (!show || !m?.track) return;
    const pos = m.position_ms + (m.playing ? since : 0);
    const pct = m.track.duration_ms ? Math.min(100, (pos / m.track.duration_ms) * 100) : 0;
    (this.el.querySelector(".mb-prog i") as HTMLElement).style.width = `${pct}%`;
  }
}
