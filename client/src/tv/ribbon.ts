import { Container, Graphics } from "pixi.js";
import type { RibbonColors, RibbonState } from "../protocol";

function hex(c: string | undefined, fallback: number): number {
  if (!c) return fallback;
  const n = parseInt(c.replace("#", ""), 16);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * 리본이: 도트 얼굴. 눈동자가 gaze 목표를 따라가고, 상태에 따라 표정이 바뀐다.
 * 그리기는 Graphics 로 매 프레임 다시 그린다 (스프라이트 시트로 교체하기 쉽도록 draw() 한 곳에 모아둠).
 */
export class RibbonSprite extends Container {
  private g = new Graphics();
  private state: RibbonState = "idle";
  private pupil = { x: 0, y: 0 };
  private target = { x: 0, y: 0 };
  private blink = 0;
  private nextBlink = 2000;
  private t = 0;
  private mouthLevel = 0;
  private wander = { x: 0, y: 0, until: 0 };
  private colors = { body: 0xff7aa8, wing: 0xff9ec4, bow: 0xffd54a, cheek: 0xff4d88 };

  constructor() {
    super();
    this.addChild(this.g);
  }

  setState(s: RibbonState): void { this.state = s; }

  setColors(c: Partial<RibbonColors> | undefined): void {
    if (!c) return;
    this.colors = {
      body: hex(c.body, 0xff7aa8), wing: hex(c.wing, 0xff9ec4), bow: hex(c.bow, 0xffd54a), cheek: hex(c.cheek, 0xff4d88),
    };
  }

  /** -1~1 (왼쪽/위가 음수) */
  lookAt(x: number, y: number): void { this.target = { x, y }; }

  /** 아무도 없을 때 호출: 천천히 두리번 */
  lookAround(now: number): void {
    if (now > this.wander.until) {
      this.wander = { x: (Math.random() - 0.5) * 1.2, y: (Math.random() - 0.5) * 0.6, until: now + 1500 + Math.random() * 2500 };
    }
    this.target = { x: this.wander.x, y: this.wander.y };
  }

  setMouthLevel(v: number): void { this.mouthLevel = v; }

  update(dtMs: number): void {
    this.t += dtMs;
    const k = 1 - Math.exp(-dtMs / 120);
    this.pupil.x += (this.target.x - this.pupil.x) * k;
    this.pupil.y += (this.target.y - this.pupil.y) * k;
    this.nextBlink -= dtMs;
    if (this.nextBlink <= 0) { this.blink = 140; this.nextBlink = 2500 + Math.random() * 3000; }
    if (this.blink > 0) this.blink -= dtMs;
    this.draw();
  }

  private draw(): void {
    const g = this.g;
    const c = this.colors;
    g.clear();
    const bob = this.state === "idle" ? Math.round(Math.sin(this.t / 600) * 1) : 0;
    const y0 = -30 + bob;

    // 몸통 (둥근 리본 매듭 모양)
    g.rect(-12, y0, 24, 22).fill(c.body);
    g.rect(-14, y0 + 3, 28, 16).fill(c.body);
    g.rect(-12, y0 + 22, 24, 2).fill({ color: c.body, alpha: 0.6 });
    g.rect(-12, y0 + 22, 24, 2).fill({ color: 0x000000, alpha: 0.25 });
    // 리본 날개
    g.poly([-14, y0 + 6, -24, y0 - 2, -24, y0 + 16, -14, y0 + 12]).fill(c.wing);
    g.poly([14, y0 + 6, 24, y0 - 2, 24, y0 + 16, 14, y0 + 12]).fill(c.wing);
    // 머리 위 작은 리본
    g.rect(-3, y0 - 5, 6, 5).fill(c.bow);

    // 눈
    const eyeOpen = this.blink > 0 ? 1 : (this.state === "listening" ? 7 : 6);
    const px = Math.round(this.pupil.x * 2), py = Math.round(this.pupil.y * 1.5);
    for (const ex of [-6, 6]) {
      g.rect(ex - 3, y0 + 7, 6, eyeOpen).fill(0xffffff);
      if (this.blink <= 0) {
        const lookUp = this.state === "thinking" ? -2 : 0;
        g.rect(ex - 1 + px, y0 + 9 + py + lookUp, 3, 3).fill(0x2b1b2e);
      }
    }
    // 입
    const mouthY = y0 + 17;
    if (this.state === "speaking") {
      const open = 1 + Math.round(this.mouthLevel * 4);
      g.rect(-3, mouthY, 6, open).fill(0x7a2040);
    } else if (this.state === "thinking") {
      g.rect(-2, mouthY, 4, 1).fill(0x7a2040);
      const dots = Math.floor(this.t / 400) % 4;
      for (let i = 0; i < dots; i++) g.rect(16 + i * 4, y0 - 2 - i * 2, 2, 2).fill(0xffffff);
    } else if (this.state === "listening") {
      g.rect(-2, mouthY, 4, 2).fill(0x7a2040);
    } else {
      g.rect(-3, mouthY, 2, 1).fill(0x7a2040);
      g.rect(-1, mouthY + 1, 2, 1).fill(0x7a2040);
      g.rect(1, mouthY, 2, 1).fill(0x7a2040);
    }
    // 볼
    g.rect(-11, y0 + 13, 2, 1).fill(c.cheek);
    g.rect(9, y0 + 13, 2, 1).fill(c.cheek);
    // 그림자
    g.rect(-10, 0, 20, 2).fill({ color: 0x000000, alpha: 0.25 });
  }
}
