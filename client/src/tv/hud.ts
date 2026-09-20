import type { KidInfo, TurnInfo } from "../protocol";

/** DOM 기반 HUD: 대기 순서 칩. 자막은 2026-09-21 에 없앴다 (관리자 대시보드에만 대화가 남는다) */
export class Hud {
  private hud = document.getElementById("hud")!;

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

}
