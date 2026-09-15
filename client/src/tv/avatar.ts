import { Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { KidInfo } from "../protocol";
import type { IsoPoint } from "./scene";

function hex(c: string | undefined, fallback: number): number {
  if (!c) return fallback;
  const n = parseInt(c.replace("#", ""), 16);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * 아이 아바타: 조립식 도트 사람. 문에서 걸어 들어와 자리에 앉는다.
 * 대기 중이면 손을 들고, 말하는 중이면 말풍선을 띄운다.
 * avatar.sprite_url 이 있으면 (관리자 페이지에서 올린 PNG) 조립식 대신 그 그림을 쓴다.
 */
export class AvatarSprite extends Container {
  private g = new Graphics();
  private nameText: Text;
  private sprite: Sprite | null = null;
  private spriteUrl: string | null = null;
  private pos: IsoPoint;
  private dest: IsoPoint | null = null;
  private onArrive: (() => void) | null = null;
  private step = 0;
  handRaised = false;
  talking = false;
  kid: KidInfo;

  constructor(kid: KidInfo, start: IsoPoint) {
    super();
    this.kid = kid;
    this.pos = { ...start };
    this.nameText = new Text({ text: kid.name, style: { fontFamily: "monospace", fontSize: 8, fill: 0xffffff } });
    this.nameText.anchor.set(0.5, 0);
    this.nameText.y = 3;
    this.addChild(this.g, this.nameText);
    this.x = Math.round(this.pos.x); this.y = Math.round(this.pos.y);
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
          const scale = Math.min(1, 24 / tex.height); // 높이 24px 안에 맞춘다
          s.scale.set(scale);
          this.sprite = s;
          this.addChildAt(s, 1);
        }).catch((e) => console.warn("sprite load failed", url, e));
      }
    }
  }

  walkTo(p: IsoPoint, onArrive?: () => void): void {
    this.dest = { ...p };
    this.onArrive = onArrive ?? null;
  }

  get worldPos(): IsoPoint { return { x: this.x, y: this.y }; }

  update(dtMs: number): void {
    if (this.dest) {
      const dx = this.dest.x - this.pos.x, dy = this.dest.y - this.pos.y;
      const dist = Math.hypot(dx, dy);
      const speed = 0.045 * dtMs; // px/ms
      if (dist <= speed) {
        this.pos = { ...this.dest };
        this.dest = null;
        this.step = 0;
        const cb = this.onArrive; this.onArrive = null; cb?.();
      } else {
        this.pos.x += (dx / dist) * speed;
        this.pos.y += (dy / dist) * speed;
        this.step += dtMs;
      }
      this.x = Math.round(this.pos.x); this.y = Math.round(this.pos.y);
    }
    if (this.sprite) this.sprite.y = this.dest ? -Math.abs(Math.round(Math.sin(this.step / 120) * 1)) : 0;
    this.draw();
  }

  private draw(): void {
    const g = this.g;
    g.clear();
    const a = this.kid.avatar ?? {};
    const skin = hex(a.skin, 0xf2c9a0), hair = hex(a.hair_color, 0x3b2a1a), top = hex(a.top, 0xe74c3c);
    const walking = this.dest !== null;
    const legPhase = walking ? Math.floor(this.step / 120) % 2 : 0;

    if (!this.sprite) {
      // 다리
      g.rect(-3, -6, 2, 6 - legPhase).fill(0x2c3e50);
      g.rect(1, -6, 2, 6 - (1 - legPhase) * (walking ? 1 : 0)).fill(0x2c3e50);
      // 몸통
      g.rect(-4, -14, 8, 8).fill(top);
      // 팔 (손들기)
      if (this.handRaised) {
        g.rect(5, -22, 2, 9).fill(skin);
      } else {
        g.rect(-6, -13, 2, 6).fill(skin);
        g.rect(4, -13, 2, 6).fill(skin);
      }
      // 머리
      g.rect(-4, -22, 8, 8).fill(skin);
      // 머리카락 스타일
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
      // 눈
      g.rect(-3, -19, 1, 1).fill(0x222222);
      g.rect(2, -19, 1, 1).fill(0x222222);
    } else if (this.handRaised) {
      // 스프라이트 위에 손 든 표시 (작은 손)
      g.rect(6, -30, 3, 6).fill(skin);
    }
    // 말풍선
    if (this.talking) {
      g.rect(-6, -32, 12, 7).fill(0xffffff);
      g.poly([-1, -25, 1, -25, 0, -23]).fill(0xffffff);
      for (let i = 0; i < 3; i++) g.rect(-4 + i * 4, -29, 2, 2).fill(0x555555);
    }
    // 그림자
    g.rect(-4, -1, 8, 1).fill({ color: 0x000000, alpha: 0.25 });
  }
}
