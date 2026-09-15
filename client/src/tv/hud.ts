import type { KidInfo, TurnInfo } from "../protocol";

/** DOM 기반 HUD: 대기 순서 칩과 자막. */
export class Hud {
  private hud = document.getElementById("hud")!;
  private caption = document.getElementById("caption")!;
  private captionTimer = 0;

  setQueue(queue: TurnInfo[], kids: KidInfo[]): void {
    const name = (id: string) => kids.find((k) => k.id === id)?.name ?? "친구";
    this.hud.innerHTML = "";
    for (const t of queue) {
      const el = document.createElement("div");
      el.className = "chip" + (t.state === "active" ? " active" : "");
      el.textContent = t.state === "active" ? `★ ${name(t.kid_id)}` : `✋ ${t.position}. ${name(t.kid_id)}`;
      this.hud.appendChild(el);
    }
  }

  showCaption(text: string, ms = 6000): void {
    this.caption.textContent = text;
    this.caption.style.display = "block";
    clearTimeout(this.captionTimer);
    this.captionTimer = window.setTimeout(() => { this.caption.style.display = "none"; }, ms);
  }
}
