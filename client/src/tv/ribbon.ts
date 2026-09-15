import { Assets, ColorMatrixFilter, Container, Graphics, Sprite, Texture } from "pixi.js";
import type { RibbonColors, RibbonState } from "../protocol";

function hex(c: string | undefined, fallback: number): number {
  if (!c) return fallback;
  const n = parseInt(c.replace("#", ""), 16);
  return Number.isNaN(n) ? fallback : n;
}
function hueOf(rgb: number): number {
  const r = ((rgb >> 16) & 255) / 255, g = ((rgb >> 8) & 255) / 255, b = (rgb & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return h;
}

/** 리본이 얼굴 좌표 (스프라이트 발끝 원점, 배율 전). 몸 그림을 바꾸면 여기만 맞추면 된다 */
export const RIBBON_FACE = {
  file: "/characters/ribbon.png",
  baseHue: 350,                  // 그림의 원래 분홍 색조. 관리자 색과의 차이만큼 회전한다
  eyes: [[-20, -62], [6, -62]] as [number, number][],
  eyeW: 11, eyeH: 12,
  mouth: [-6, -44] as [number, number],
  cheeks: [[-27, -48], [21, -48]] as [number, number][],
};

/**
 * 리본이: 픽셀아트 몸 스프라이트 + 코드가 그리는 눈·입.
 * 눈동자가 시선 목표를 따라가고, 상태에 따라 표정이 바뀐다. 말할 때 입이 음량에 맞춰 열린다.
 * 스프라이트 로딩 전이나 실패 시에는 예전 도트 얼굴을 그린다.
 */
export class RibbonSprite extends Container {
  private body: Sprite | null = null;
  private face = new Graphics();
  private fallback = new Graphics();
  private hueFilter = new ColorMatrixFilter();
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
    this.addChild(this.fallback, this.face);
    void Assets.load<Texture>({ src: RIBBON_FACE.file, parser: "loadTextures" }).then((tex) => {
      tex.source.scaleMode = "nearest";
      const s = new Sprite(tex);
      s.anchor.set(0.5, 1);
      s.filters = [this.hueFilter];
      this.body = s;
      this.addChildAt(s, 0);
      this.fallback.clear();
      this.applyHue();
    }).catch((e) => console.warn("ribbon sprite load failed", e));
  }

  setState(s: RibbonState): void { this.state = s; }

  setColors(c: Partial<RibbonColors> | undefined): void {
    if (!c) return;
    this.colors = { body: hex(c.body, 0xff7aa8), wing: hex(c.wing, 0xff9ec4), bow: hex(c.bow, 0xffd54a), cheek: hex(c.cheek, 0xff4d88) };
    this.applyHue();
  }

  private applyHue(): void {
    const delta = hueOf(this.colors.body) - RIBBON_FACE.baseHue;
    this.hueFilter.reset();
    if (Math.abs(((delta % 360) + 360) % 360) > 2) this.hueFilter.hue(delta, false);
  }

  /** -1~1 (왼쪽/위가 음수) */
  lookAt(x: number, y: number): void { this.target = { x, y }; }

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
    // 대기 중 살짝 숨쉬기
    const bob = this.state === "idle" ? Math.sin(this.t / 700) * 0.015 : 0;
    if (this.body) { this.body.scale.set(1 + bob * 0.5, 1 - bob); }
    if (this.body) this.drawFace(); else this.drawFallback();
  }

  private drawFace(): void {
    const g = this.face;
    g.clear();
    const F = RIBBON_FACE;
    const px = Math.round(this.pupil.x * 2), py = Math.round(this.pupil.y * 1.5);
    const lookUp = this.state === "thinking" ? -2 : 0;
    const open = this.blink > 0 ? 1 : (this.state === "listening" ? F.eyeH + 1 : F.eyeH);
    for (const [ex, ey] of F.eyes) {
      g.roundRect(ex - 1, ey - 1, F.eyeW + 2, open + 2, 2).fill(0x5a2a3a);
      g.roundRect(ex, ey, F.eyeW, open, 2).fill(0xffffff);
      if (this.blink <= 0) {
        g.roundRect(ex + 3 + px, ey + 3 + py + lookUp, 5, 6, 2).fill(0x2b1b2e);
        g.rect(ex + 4 + px, ey + 4 + py + lookUp, 2, 2).fill(0xffffff);
      }
    }
    const [mx, my] = F.mouth;
    if (this.state === "speaking") {
      const h = 3 + Math.round(this.mouthLevel * 7);
      g.roundRect(mx, my, 12, h, 3).fill(0x7a2040);
      if (h > 5) g.roundRect(mx + 2, my + h - 3, 8, 3, 1).fill(0xff8fa8);
    } else if (this.state === "thinking") {
      g.roundRect(mx + 2, my + 1, 8, 3, 1).fill(0x7a2040);
      const dots = Math.floor(this.t / 400) % 4;
      for (let i = 0; i < dots; i++) g.rect(34 + i * 6, -78 - i * 4, 4, 4).fill(0xffffff);
    } else if (this.state === "listening") {
      g.roundRect(mx + 1, my, 10, 5, 2).fill(0x7a2040);
    } else {
      // 살짝 웃는 입
      g.rect(mx, my, 3, 2).fill(0x7a2040);
      g.rect(mx + 3, my + 2, 6, 2).fill(0x7a2040);
      g.rect(mx + 9, my, 3, 2).fill(0x7a2040);
    }
    for (const [cx, cy] of F.cheeks) g.ellipse(cx, cy, 4, 2).fill({ color: this.colors.cheek, alpha: 0.55 });
    g.ellipse(0, 1, 26, 5).fill({ color: 0x000000, alpha: 0.2 });
  }

  /** 스프라이트가 없을 때의 옛 도트 얼굴 */
  private drawFallback(): void {
    const g = this.fallback;
    const c = this.colors;
    g.clear();
    const y0 = -25;
    g.rect(-12, y0, 24, 22).fill(c.body);
    g.rect(-14, y0 + 3, 28, 16).fill(c.body);
    g.poly([-14, y0 + 6, -24, y0 - 2, -24, y0 + 16, -14, y0 + 12]).fill(c.wing);
    g.poly([14, y0 + 6, 24, y0 - 2, 24, y0 + 16, 14, y0 + 12]).fill(c.wing);
    g.rect(-3, y0 - 5, 6, 5).fill(c.bow);
    const px = Math.round(this.pupil.x * 2), py = Math.round(this.pupil.y * 1.5);
    for (const ex of [-6, 6]) {
      g.rect(ex - 3, y0 + 7, 6, this.blink > 0 ? 1 : 6).fill(0xffffff);
      if (this.blink <= 0) g.rect(ex - 1 + px, y0 + 9 + py, 3, 3).fill(0x2b1b2e);
    }
    g.rect(-3, y0 + 17, 6, this.state === "speaking" ? 1 + Math.round(this.mouthLevel * 4) : 1).fill(0x7a2040);
    g.ellipse(0, 1, 13, 2.5).fill({ color: 0x000000, alpha: 0.22 });
  }
}
