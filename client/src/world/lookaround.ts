import type { Stage } from "../tv/stage";

/**
 * 전시실 둘러보기 손짓 (전시실 꾸미기 · 부모님 전시실). 단추로 벽을 고르던 것을 없애고 **쓸어 넘겨서** 본다:
 *   - 한 손가락(마우스)으로 끌면 고개가 돌아가고, 놓으면 그 속도로 조금 더 돌다가 멈춘다
 *   - 멈출 즈음 어느 벽의 정면에 가까우면 그 벽 정면으로 부드럽게 맞춰 선다
 *   - 두 손가락 벌리기 · 마우스 휠로 당겨 본다
 * 끌기를 시작할지는 부르는 쪽이 정한다 (전시실 꾸미기는 그림을 잡았으면 그림을 옮기고, 빈 곳을 잡았을 때만 begin 을 부른다).
 */
const SNAPS = [-Math.PI / 2, 0, Math.PI / 2];      // 오른쪽 벽 · 정면 벽 · 왼쪽 벽
const SNAP_NEAR = 0.3;                             // 이만큼(라디안) 안쪽이면 정면으로 맞춘다
const FRICTION = 3.2;                              // 놓은 뒤 속도가 줄어드는 빠르기 (1/초)

export class LookAround {
  private pointers = new Map<number, { x: number; y: number }>();
  private vel = 0;                                 // 놓은 뒤 남은 회전 속도 (라디안/초)
  private lastMove = 0;
  private pinch = 0;
  private settle: number | null = null;            // 맞춰 설 정면 각도
  private lastTick = performance.now();
  /** 끈 거리 (픽셀). 거의 안 움직였으면 누른 것으로 본다 */
  moved = 0;

  constructor(private stage: Stage, private el: HTMLElement) {
    el.addEventListener("wheel", (ev) => {
      if (!stage.looking) return;
      ev.preventDefault();
      stage.look(stage.yaw, stage.pitch, stage.lookFov * (ev.deltaY > 0 ? 1.08 : 0.92));
    }, { passive: false });
  }

  get dragging(): boolean { return this.pointers.size > 0; }

  begin(ev: PointerEvent): void {
    if (!this.pointers.size) this.moved = 0;
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    this.vel = 0;
    this.settle = null;
    this.pinch = this.spread();
    try { this.el.setPointerCapture(ev.pointerId); } catch { /* 이미 놓인 손가락 */ }
  }

  move(ev: PointerEvent): void {
    const p = this.pointers.get(ev.pointerId);
    if (!p) return;
    const dx = ev.clientX - p.x, dy = ev.clientY - p.y;
    p.x = ev.clientX;
    p.y = ev.clientY;
    const s = this.stage;
    if (this.pointers.size >= 2) {                 // 두 손가락: 벌리면 당겨 본다
      const d = this.spread();
      if (this.pinch > 0 && d > 0) s.look(s.yaw, s.pitch, s.lookFov * (this.pinch / d));
      this.pinch = d;
      return;
    }
    this.moved += Math.abs(dx) + Math.abs(dy);
    // 손가락을 따라 그림이 움직이게. 세로로 든 폰은 가로 화각이 좁아 한참 쓸어야 하므로 조금 더 돌려 준다
    const perPx = Math.max(s.lookSpan, 1.4) / Math.max(1, this.el.clientWidth);
    const now = performance.now();
    const dt = Math.max(1, now - this.lastMove) / 1000;
    this.lastMove = now;
    this.vel = this.vel * 0.6 + (dx * perPx / dt) * 0.4;
    s.look(s.yaw + dx * perPx, s.pitch + dy * perPx);
  }

  end(ev: PointerEvent): void {
    this.pointers.delete(ev.pointerId);
    this.pinch = this.spread();
    if (this.pointers.size) return;
    if (performance.now() - this.lastMove > 120) this.vel = 0;     // 멈췄다가 놓았으면 더 돌지 않는다
    this.vel = Math.max(-6, Math.min(6, this.vel));
    if (Math.abs(this.vel) <= 0.35 && this.moved > 6) this.snap();
  }

  /** 가까운 벽 정면이 있으면 그리로 맞춰 선다 */
  private snap(): void {
    const near = SNAPS.find((a) => Math.abs(a - this.stage.yaw) < SNAP_NEAR);
    if (near !== undefined) { this.settle = near; this.vel = 0; }
  }

  /** 매 프레임: 놓은 뒤 남은 회전과 정면 맞추기 */
  tick(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const s = this.stage;
    if (!s.looking || this.pointers.size) return;
    if (Math.abs(this.vel) > 0.02) {
      s.look(s.yaw + this.vel * dt, s.pitch);
      this.vel *= Math.exp(-FRICTION * dt);
      if (Math.abs(this.vel) <= 0.35) this.snap();   // 거의 멈췄다
      return;
    }
    if (this.settle !== null) {
      const k = 1 - Math.exp(-7 * dt);
      s.look(s.yaw + (this.settle - s.yaw) * k, s.pitch + (0 - s.pitch) * k * 0.5);
      if (Math.abs(this.settle - s.yaw) < 0.002) this.settle = null;
    }
  }

  private spread(): number {
    const ps = [...this.pointers.values()];
    return ps.length >= 2 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0;
  }
}
