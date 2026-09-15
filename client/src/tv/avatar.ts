import { Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { KidInfo } from "../protocol";
import type { FloorPos, Projector } from "./scene";

function hex(c: string | undefined, fallback: number): number {
  if (!c) return fallback;
  const n = parseInt(c.replace("#", ""), 16);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * 아이 아바타: 조립식 도트 사람. 바닥 좌표(bx, t) 로 움직이고, 깊이에 따라 화면 배율이 바뀐다.
 * 대기 중이면 손을 들고, 말하는 중이면 말풍선을 띄운다.
 * avatar.sprite_url 이 있으면 (관리자 페이지에서 올린 PNG) 조립식 대신 그 그림을 쓴다.
 */
export class AvatarSprite extends Container {
  private g = new Graphics();
  private nameText: Text;
  private sprite: Sprite | null = null;
  private spriteUrl: string | null = null;
  private pos: FloorPos;
  private dest: FloorPos | null = null;
  private onArrive: (() => void) | null = null;
  private step = 0;
  handRaised = false;
  talking = false;
  kid: KidInfo;

  constructor(kid: KidInfo, start: FloorPos, private projector: Projector, private baseScale = 1) {
    super();
    this.kid = kid;
    this.pos = { ...start };
    this.nameText = new Text({
      text: kid.name, resolution: 4,
      style: { fontFamily: "'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif", fontSize: 7, fill: 0xffffff, stroke: { color: 0x000000, width: 2 } },
    });
    this.nameText.anchor.set(0.5, 1);
    this.nameText.y = -27; // 머리 위 (테이블에 가려지지 않게)
    this.nameText.scale.set(0.55); // 아바타가 깊이 배율로 커져도 이름은 작게
    this.addChild(this.g, this.nameText);
    this.place();
    this.setKid(kid);
    this.draw();
  }

  /** 관리자 페이지에서 바뀐 이름/외형을 반영 */
  setKid(kid: KidInfo): void {
    this.kid = kid;
    this.nameText.text = kid.name;
    const url = kid.avatar?.sprite_url || null;
    if (url !== this.spriteUrl) {
      this.spriteUrl = url;
      if (this.sprite) { this.removeChild(this.sprite); this.sprite.destroy(); this.sprite = null; }
      if (url) {
        void Assets.load<Texture>(url).then((tex) => {
          if (this.spriteUrl !== url) return;
          tex.source.scaleMode = "nearest";
          const s = new Sprite(tex);
          s.anchor.set(0.5, 1);
          s.scale.set(Math.min(1, 26 / tex.height)); // 높이 26px 안에 맞춘다
          this.sprite = s;
          this.addChildAt(s, 1);
        }).catch((e) => console.warn("sprite load failed", url, e));
      }
    }
  }

  walkTo(p: FloorPos, onArrive?: () => void): void {
    this.dest = { ...p };
    this.onArrive = onArrive ?? null;
  }

  get floorPos(): FloorPos { return { ...this.pos }; }
  get worldPos(): { x: number; y: number } { return { x: this.x, y: this.y }; }

  private place(): void {
    const p = this.projector.toScreen(this.pos);
    this.x = Math.round(p.x); this.y = Math.round(p.y);
    this.scale.set(p.s * this.baseScale);
  }

  update(dtMs: number): void {
    if (this.dest) {
      const dbx = this.dest.bx - this.pos.bx, dt = this.dest.t - this.pos.t;
      const dist = Math.hypot(dbx, dt * 120); // t 1.0 ≈ 뒷벽 120px 거리
      const speed = 0.04 * dtMs;
      if (dist <= speed) {
        this.pos = { ...this.dest };
        this.dest = null;
        this.step = 0;
        const cb = this.onArrive; this.onArrive = null; cb?.();
      } else {
        this.pos.bx += (dbx / dist) * speed;
        this.pos.t += ((dt * 120) / dist) * speed / 120;
        this.step += dtMs;
      }
      this.place();
    }
    if (this.sprite) this.sprite.y = this.dest ? -Math.abs(Math.round(Math.sin(this.step / 120))) : 0;
    this.draw();
  }

  private draw(): void {
    const g = this.g;
    g.clear();
    const a = this.kid.avatar ?? {};
    const skin = hex(a.skin, 0xf2c9a0), hair = hex(a.hair_color, 0x3b2a1a), top = hex(a.top, 0xe74c3c);
    const walking = this.dest !== null;
    const legPhase = walking ? Math.floor(this.step / 120) % 2 : 0;
    const outline = 0x2b1b2e;

    if (!this.sprite) {
      // 다리
      g.rect(-3, -6, 2, 6 - legPhase).fill(0x2c3e50);
      g.rect(1, -6, 2, 6 - (1 - legPhase) * (walking ? 1 : 0)).fill(0x2c3e50);
      // 몸통 + 윤곽
      g.rect(-5, -15, 10, 10).fill(outline);
      g.rect(-4, -14, 8, 8).fill(top);
      g.rect(-1, -13, 2, 6).fill({ color: 0xffffff, alpha: 0.25 });
      // 팔 (손들기)
      if (this.handRaised) {
        g.rect(5, -23, 2, 10).fill(skin);
        g.rect(4, -25, 4, 3).fill(skin);
      } else {
        g.rect(-6, -13, 2, 6).fill(skin);
        g.rect(4, -13, 2, 6).fill(skin);
      }
      // 머리 + 윤곽
      g.rect(-5, -23, 10, 10).fill(outline);
      g.rect(-4, -22, 8, 8).fill(skin);
      // 머리카락
      switch (a.hair) {
        case "twin":
          g.rect(-4, -23, 8, 3).fill(hair); g.rect(-7, -21, 3, 6).fill(hair); g.rect(4, -21, 3, 6).fill(hair); break;
        case "spiky":
          g.rect(-4, -23, 8, 2).fill(hair); g.rect(-3, -25, 2, 2).fill(hair); g.rect(1, -25, 2, 2).fill(hair); break;
        case "bowl":
          g.rect(-5, -23, 10, 4).fill(hair); break;
        case "long":
          g.rect(-5, -23, 10, 3).fill(hair); g.rect(-6, -21, 2, 9).fill(hair); g.rect(4, -21, 2, 9).fill(hair); break;
        case "curly":
          g.rect(-5, -24, 10, 4).fill(hair); g.rect(-6, -22, 1, 3).fill(hair); g.rect(5, -22, 1, 3).fill(hair); g.rect(-3, -25, 2, 1).fill(hair); g.rect(1, -25, 2, 1).fill(hair); break;
        case "bun":
          g.rect(-4, -23, 8, 3).fill(hair); g.rect(-2, -26, 4, 3).fill(hair); break;
        default:
          g.rect(-4, -23, 8, 3).fill(hair);
      }
      // 눈, 볼
      g.rect(-3, -19, 1, 1).fill(0x222222);
      g.rect(2, -19, 1, 1).fill(0x222222);
      g.rect(-4, -17, 1, 1).fill({ color: 0xff7aa8, alpha: 0.7 });
      g.rect(3, -17, 1, 1).fill({ color: 0xff7aa8, alpha: 0.7 });
    } else if (this.handRaised) {
      g.rect(6, -30, 3, 6).fill(skin);
    }
    // 말풍선
    if (this.talking) {
      g.rect(-7, -33, 14, 8).fill(outline);
      g.rect(-6, -32, 12, 6).fill(0xffffff);
      g.poly([-1, -26, 1, -26, 0, -24]).fill(0xffffff);
      const k = Math.floor(performance.now() / 300) % 3;
      for (let i = 0; i < 3; i++) g.rect(-4 + i * 4, -30, 2, 2).fill(i === k ? 0x222222 : 0x999999);
    }
    // 그림자
    g.ellipse(0, 0, 6, 2).fill({ color: 0x000000, alpha: 0.22 });
  }
}
