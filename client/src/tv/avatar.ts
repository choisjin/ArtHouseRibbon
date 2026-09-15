import { Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { KidInfo } from "../protocol";
import type { FloorPos } from "./room/spec";
import type { Projector } from "./room/projection";

function hex(c: string | undefined, fallback: number): number {
  if (!c) return fallback;
  const n = parseInt(c.replace("#", ""), 16);
  return Number.isNaN(n) ? fallback : n;
}

type Dir = "south" | "south-west" | "west" | "north-west" | "north" | "north-east" | "east" | "south-east";
interface SpriteSet { idle: Dir[]; walk: Record<string, number>; frame: [number, number] }

/**
 * 아이 아바타. 바닥 좌표(bx, t) 로 움직이고, 깊이에 따라 화면 배율이 바뀐다.
 * 그림 우선순위: avatar.sprite_set(8방향 픽셀아트) > avatar.sprite_url(단일 PNG) > 조립식 도트 드로잉.
 * 손들기·말풍선·이름표는 어느 경우든 코드가 위에 그린다.
 */
export class AvatarSprite extends Container {
  private g = new Graphics();
  private nameText: Text;
  private sprite: Sprite | null = null;       // sprite_set 또는 sprite_url 로 만든 스프라이트
  private set: SpriteSet | null = null;
  private setName: string | null = null;
  private frames = new Map<string, Texture>();  // "idle_south", "walk_east_0" ...
  private spriteUrl: string | null = null;
  private pos: FloorPos;
  private dest: FloorPos | null = null;
  private onArrive: (() => void) | null = null;
  private step = 0;
  private dir: Dir = "south";
  private bodyH = 24;                           // 그림 높이(배율 전). 오버레이 위치 기준
  handRaised = false;
  talking = false;
  kid: KidInfo;

  constructor(kid: KidInfo, start: FloorPos, private projector: Projector, private baseScale = 1) {
    super();
    this.kid = kid;
    this.pos = { ...start };
    this.nameText = new Text({
      text: kid.name, resolution: 4,
      style: { fontFamily: "'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif", fontSize: 11, fill: 0xffffff, stroke: { color: 0x000000, width: 3 } },
    });
    this.nameText.anchor.set(0.5, 1);
    this.nameText.scale.set(0.75);
    this.addChild(this.g, this.nameText);
    this.place();
    this.setKid(kid);
    this.draw();
  }

  /** 관리자 페이지에서 바뀐 이름/외형을 반영 */
  setKid(kid: KidInfo): void {
    this.kid = kid;
    this.nameText.text = kid.name;
    const setName = kid.avatar?.sprite_set || null;
    const url = kid.avatar?.sprite_url || null;
    if (setName !== this.setName) {
      this.setName = setName;
      this.set = null;
      this.frames.clear();
      if (setName) void this.loadSet(setName);
    }
    if (!setName && url !== this.spriteUrl) {
      this.spriteUrl = url;
      this.dropSprite();
      if (url) {
        void Assets.load<Texture>({ src: url, parser: "loadTextures" }).then((tex) => {
          if (this.spriteUrl !== url || this.setName) return;
          tex.source.scaleMode = "nearest";
          this.ensureSprite(tex);
          this.sprite!.scale.set(Math.min(1, 40 / tex.height));
          this.bodyH = Math.min(40, tex.height);
        }).catch((e) => console.warn("sprite load failed", url, e));
      }
    }
    if (!setName && !url) { this.dropSprite(); this.bodyH = 24; }
  }

  private async loadSet(name: string): Promise<void> {
    const base = `/characters/${name}`;
    try {
      const res = await fetch(`${base}/set.json`);
      if (!res.ok) throw new Error(String(res.status));
      const set = (await res.json()) as SpriteSet;
      if (this.setName !== name) return;
      const jobs: Promise<void>[] = [];
      for (const d of set.idle) jobs.push(this.loadFrame(`idle_${d}`, `${base}/idle_${d}.png`));
      for (const [d, n] of Object.entries(set.walk ?? {})) for (let i = 0; i < n; i++) jobs.push(this.loadFrame(`walk_${d}_${i}`, `${base}/walk_${d}_${i}.png`));
      await Promise.all(jobs);
      if (this.setName !== name) return;
      this.set = set;
      this.bodyH = set.frame[1];
      const tex = this.frames.get("idle_south") ?? [...this.frames.values()][0];
      if (tex) { this.ensureSprite(tex); this.sprite!.scale.set(1); }
    } catch (e) {
      console.warn("sprite set load failed", name, e);
    }
  }

  private async loadFrame(key: string, url: string): Promise<void> {
    try {
      const tex = await Assets.load<Texture>({ src: url, parser: "loadTextures" });
      tex.source.scaleMode = "nearest";
      this.frames.set(key, tex);
    } catch { /* 없는 프레임은 건너뜀 */ }
  }

  private ensureSprite(tex: Texture): void {
    if (!this.sprite) {
      this.sprite = new Sprite(tex);
      this.sprite.anchor.set(0.5, 1);
      this.addChildAt(this.sprite, 1);
    } else {
      this.sprite.texture = tex;
    }
  }

  private dropSprite(): void {
    if (this.sprite) { this.removeChild(this.sprite); this.sprite.destroy(); this.sprite = null; }
  }

  walkTo(p: FloorPos, onArrive?: () => void): void {
    this.dest = { ...p };
    this.onArrive = onArrive ?? null;
  }

  get floorPos(): FloorPos { return { ...this.pos }; }
  get worldPos(): { x: number; y: number } { return { x: this.x, y: this.y }; }
  /** 머리 위 화면 y (시선 목표용) */
  get headY(): number { return this.y - this.bodyH * this.scale.y; }

  private place(): void {
    const p = this.projector.toScreen(this.pos);
    this.x = Math.round(p.x); this.y = Math.round(p.y);
    this.scale.set(p.s * this.baseScale);
  }

  update(dtMs: number): void {
    if (this.dest) {
      const dbx = this.dest.bx - this.pos.bx, dt = this.dest.t - this.pos.t;
      const dist = Math.hypot(dbx, dt * 200); // t 1.0 ≈ 뒷벽 200px 거리
      const speed = 0.06 * dtMs;
      this.dir = dirOf(dbx, dt);
      if (dist <= speed) {
        this.pos = { ...this.dest };
        this.dest = null;
        this.step = 0;
        this.dir = "south";
        const cb = this.onArrive; this.onArrive = null; cb?.();
      } else {
        this.pos.bx += (dbx / dist) * speed;
        this.pos.t += ((dt * 200) / dist) * speed / 200;
        this.step += dtMs;
      }
      this.place();
    }
    this.updateFrame();
    this.draw();
  }

  private updateFrame(): void {
    if (!this.sprite || !this.set) return;
    const walking = this.dest !== null;
    let tex: Texture | undefined;
    if (walking) {
      const n = this.set.walk?.[this.dir] ?? 0;
      if (n > 0) tex = this.frames.get(`walk_${this.dir}_${Math.floor(this.step / 110) % n}`);
    }
    if (!tex) tex = this.frames.get(`idle_${this.dir}`) ?? this.frames.get("idle_south");
    if (tex && this.sprite.texture !== tex) this.sprite.texture = tex;
    // 걷기 프레임이 없으면 통통 튀는 걸음으로 대신
    this.sprite.y = walking && !(this.set.walk?.[this.dir]) ? -Math.abs(Math.round(Math.sin(this.step / 100) * 2)) : 0;
  }

  private draw(): void {
    const g = this.g;
    g.clear();
    const a = this.kid.avatar ?? {};
    const skin = hex(a.skin, 0xf2c9a0), hair = hex(a.hair_color, 0x3b2a1a), top = hex(a.top, 0xe74c3c);
    const walking = this.dest !== null;
    const legPhase = walking ? Math.floor(this.step / 120) % 2 : 0;
    const outline = 0x2b1b2e;
    const h = this.bodyH;
    this.nameText.y = -h - 4;

    if (!this.sprite) {
      // 조립식 도트 사람 (스프라이트가 없을 때)
      g.rect(-3, -6, 2, 6 - legPhase).fill(0x2c3e50);
      g.rect(1, -6, 2, 6 - (1 - legPhase) * (walking ? 1 : 0)).fill(0x2c3e50);
      g.rect(-5, -15, 10, 10).fill(outline);
      g.rect(-4, -14, 8, 8).fill(top);
      if (this.handRaised) { g.rect(5, -23, 2, 10).fill(skin); g.rect(4, -25, 4, 3).fill(skin); }
      else { g.rect(-6, -13, 2, 6).fill(skin); g.rect(4, -13, 2, 6).fill(skin); }
      g.rect(-5, -23, 10, 10).fill(outline);
      g.rect(-4, -22, 8, 8).fill(skin);
      switch (a.hair) {
        case "twin": g.rect(-4, -23, 8, 3).fill(hair); g.rect(-7, -21, 3, 6).fill(hair); g.rect(4, -21, 3, 6).fill(hair); break;
        case "spiky": g.rect(-4, -23, 8, 2).fill(hair); g.rect(-3, -25, 2, 2).fill(hair); g.rect(1, -25, 2, 2).fill(hair); break;
        case "bowl": g.rect(-5, -23, 10, 4).fill(hair); break;
        case "long": g.rect(-5, -23, 10, 3).fill(hair); g.rect(-6, -21, 2, 9).fill(hair); g.rect(4, -21, 2, 9).fill(hair); break;
        case "curly": g.rect(-5, -24, 10, 4).fill(hair); g.rect(-6, -22, 1, 3).fill(hair); g.rect(5, -22, 1, 3).fill(hair); break;
        case "bun": g.rect(-4, -23, 8, 3).fill(hair); g.rect(-2, -26, 4, 3).fill(hair); break;
        default: g.rect(-4, -23, 8, 3).fill(hair);
      }
      g.rect(-3, -19, 1, 1).fill(0x222222);
      g.rect(2, -19, 1, 1).fill(0x222222);
    } else if (this.handRaised) {
      // 스프라이트 옆에 손 든 표시
      const hx = Math.round(h * 0.34), hy = -Math.round(h * 0.95);
      g.rect(hx - 1, hy - 1, 6, 12).fill(outline);
      g.rect(hx, hy, 4, 10).fill(skin);
      g.rect(hx - 2, hy - 4, 8, 5).fill(outline);
      g.rect(hx - 1, hy - 3, 6, 3).fill(skin);
    }
    // 말풍선
    if (this.talking) {
      const by = -h - 12;
      g.roundRect(-9, by - 9, 18, 11, 3).fill(outline);
      g.roundRect(-8, by - 8, 16, 9, 2).fill(0xffffff);
      g.poly([-1, by + 1, 2, by + 1, 0, by + 4]).fill(0xffffff);
      const k = Math.floor(performance.now() / 300) % 3;
      for (let i = 0; i < 3; i++) g.rect(-5 + i * 4, by - 5, 2, 2).fill(i === k ? 0x222222 : 0x999999);
    }
    // 그림자
    g.ellipse(0, 0, Math.round(h * 0.28), Math.round(h * 0.08) + 1).fill({ color: 0x000000, alpha: 0.22 });
  }
}

function dirOf(dbx: number, dt: number): Dir {
  const ang = Math.atan2(dt * 200, dbx); // dt>0 = 앞으로(남쪽)
  const oct = Math.round(ang / (Math.PI / 4));
  return (["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"][((oct % 8) + 8) % 8] as Dir);
}
