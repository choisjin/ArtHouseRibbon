import { FLOOR_LAYER, rad, type Layout, type LayoutItem, type RoomInfo, type TypeInfo } from "./types";

/** 바닥 좌표 (배치 파일 단위, x 오른쪽 / y 화면 안쪽) */
export interface P2 { x: number; y: number }

/** 길을 찾을 때만 피하는 둥근 자리 (다른 캐릭터가 서 있는 곳) */
export interface Blocker { p: P2; r: number }

interface Box { e: LayoutItem; b: TypeInfo["bbox"]; c: number; s: number }

/**
 * 리본이 걸어 다닐 수 있는 바닥 격자.
 * 벽·기둥·가구 바닥 윤곽을 몸 반지름만큼 부풀려 막고, A* 로 길을 찾은 뒤 직선으로 이을 수 있는 점은 건너뛴다.
 * 칸 가운데만 보고 막힘을 정하므로, 칸 안 어디에 서도 닿지 않게 반 칸(대각선)만큼 더 부풀린다.
 * 추가로 isAllowed(보통 "TV 화면 안에 몸이 다 보이는가")로 목적지와 통로를 제한할 수 있다.
 * 다른 캐릭터는 길을 찾을 때마다 blockers 로 넘겨 피해 간다 (격자에 굽지 않는다: 계속 움직이므로).
 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  private free: Uint8Array;
  private x0: number;
  private y0: number;
  private boxes: Box[];
  private dyn: Blocker[] = [];

  constructor(room: RoomInfo, types: Map<string, TypeInfo>, layout: Layout, readonly radius: number,
              readonly cell = 0.2, isAllowed: (p: P2) => boolean = () => true) {
    const w = room.walls;
    this.x0 = w.left;
    this.y0 = room.front_y;
    this.cols = Math.max(1, Math.ceil((w.right - w.left) / cell));
    this.rows = Math.max(1, Math.ceil((w.back - room.front_y) / cell));
    this.free = new Uint8Array(this.cols * this.rows);
    const r = radius + cell * 0.71;
    this.room = room;
    const boxes: Box[] = layout.items.flatMap((e) => {
      const t = types.get(e.type);
      if (!t || FLOOR_LAYER.has(e.type) || t.bbox.z1 < 0.05) return [];
      return [{ e, b: t.bbox, c: Math.cos(rad(e.rot)), s: Math.sin(rad(e.rot)) }];
    });
    this.boxes = boxes;
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const p = this.center(i, j);
        let ok = p.x > w.left + r && p.x < w.right - r && p.y > room.front_y + r && p.y < w.back - r;
        if (ok) ok = !room.obstacles.some((o) => p.x > o.x0 - r && p.x < o.x1 + r && p.y > o.y0 - r && p.y < o.y1 + r);
        if (ok) ok = !boxes.some((bx) => hitsBox(bx, p, r));
        if (ok) ok = isAllowed(p);
        this.free[j * this.cols + i] = ok ? 1 : 0;
      }
    }
  }

  center(i: number, j: number): P2 { return { x: this.x0 + (i + 0.5) * this.cell, y: this.y0 + (j + 0.5) * this.cell }; }
  private cellOf(p: P2): [number, number] {
    return [Math.floor((p.x - this.x0) / this.cell), Math.floor((p.y - this.y0) / this.cell)];
  }
  private readonly room: RoomInfo;

  private ok(i: number, j: number): boolean {
    if (!(i >= 0 && j >= 0 && i < this.cols && j < this.rows && this.free[j * this.cols + i] === 1)) return false;
    if (!this.dyn.length) return true;
    const c = this.center(i, j);
    return !this.dyn.some((d) => Math.hypot(c.x - d.p.x, c.y - d.p.y) < d.r);
  }

  /**
   * 이 점에 반지름 r 인 몸이 들어가는가 (벽·기둥·가구, ignore 가구는 빼고). 격자 칸이 아니라 정확한 모양으로 본다.
   * 의자에 앉을 자리처럼 격자에서는 막혀 있는 곳(의자 위)을 따로 볼 때 쓴다.
   */
  fits(p: P2, r: number, ignore: LayoutItem | LayoutItem[] = []): boolean {
    const skip = Array.isArray(ignore) ? ignore : [ignore];
    const w = this.room.walls;
    if (!(p.x > w.left + r && p.x < w.right - r && p.y > this.room.front_y - r && p.y < w.back - r)) return false;
    if (this.room.obstacles.some((o) => p.x > o.x0 - r && p.x < o.x1 + r && p.y > o.y0 - r && p.y < o.y1 + r)) return false;
    return !this.boxes.some((bx) => !skip.includes(bx.e) && hitsBox(bx, p, r));
  }

  /** 이 자리에 몸(r)을 두면 걸리는 가구들 */
  itemsAt(p: P2, r: number): LayoutItem[] {
    return this.boxes.filter((bx) => hitsBox(bx, p, r)).map((bx) => bx.e);
  }

  /** a→b 직선 위 어디에서도 몸(r)이 들어가는가 (ignore 가구는 빼고) */
  lineFits(a: P2, b: P2, r: number, ignore: LayoutItem | LayoutItem[] = []): boolean {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.1));
    for (let k = 0; k <= n; k++) {
      if (!this.fits({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }, r, ignore)) return false;
    }
    return true;
  }
  isFree(p: P2): boolean { return this.ok(...this.cellOf(p)); }
  get freeCount(): number { return this.free.reduce((a, b) => a + b, 0); }

  /** 가장 가까운 빈 칸 (없으면 null) */
  nearestFree(p: P2): P2 | null {
    const [ci, cj] = this.cellOf(p);
    if (this.ok(ci, cj)) return p;
    let best: P2 | null = null, bd = Infinity;
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        if (!this.ok(i, j)) continue;
        const d = (i - ci) ** 2 + (j - cj) ** 2;
        if (d < bd) { bd = d; best = this.center(i, j); }
      }
    }
    return best;
  }

  /** 빈 칸 중 무작위 한 점 (조건을 만족하는 것) */
  randomFree(accept: (p: P2) => boolean = () => true, tries = 200): P2 | null {
    for (let k = 0; k < tries; k++) {
      const i = Math.floor(Math.random() * this.cols), j = Math.floor(Math.random() * this.rows);
      if (!this.ok(i, j)) continue;
      const c = this.center(i, j);
      const p = { x: c.x + (Math.random() - 0.5) * this.cell * 0.8, y: c.y + (Math.random() - 0.5) * this.cell * 0.8 };
      if (accept(p)) return p;
    }
    return null;
  }

  /** 두 점 사이를 막힘 없이 직선으로 갈 수 있는가 */
  lineFree(a: P2, b: P2): boolean {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(d / (this.cell * 0.5)));
    for (let k = 0; k <= n; k++) {
      if (!this.isFree({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n })) return false;
    }
    return true;
  }

  /** from → to 경로 (from 은 빼고 to 포함). blockers(다른 캐릭터 자리)는 피해 간다. 못 가면 null */
  findPath(from: P2, to: P2, blockers: Blocker[] = []): P2[] | null {
    this.dyn = blockers;
    try { return this.search(from, to); } finally { this.dyn = []; }
  }

  private search(from: P2, to: P2): P2[] | null {
    const start = this.nearestFree(from), goal = this.nearestFree(to);
    if (!start || !goal) return null;
    if (this.lineFree(start, goal)) return [goal];
    const [si, sj] = this.cellOf(start), [gi, gj] = this.cellOf(goal);
    const N = this.cols * this.rows;
    const g = new Float32Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const open = new MinHeap();
    const h = (i: number, j: number) => { const dx = Math.abs(i - gi), dy = Math.abs(j - gj); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    const s = sj * this.cols + si, goalIdx = gj * this.cols + gi;
    g[s] = 0;
    open.push(s, h(si, sj));
    while (open.size) {
      const cur = open.pop();
      if (cur === goalIdx) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const ci = cur % this.cols, cj = (cur - ci) / this.cols;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di, nj = cj + dj;
          if (!this.ok(ni, nj)) continue;
          if (di && dj && (!this.ok(ci + di, cj) || !this.ok(ci, cj + dj))) continue;   // 모서리 끼기 방지
          const ng = g[cur] + (di && dj ? 1.414 : 1);
          const n = nj * this.cols + ni;
          if (ng < g[n]) { g[n] = ng; prev[n] = cur; open.push(n, ng + h(ni, nj)); }
        }
      }
    }
    if (prev[goalIdx] < 0) return null;
    const cells: P2[] = [];
    for (let c = goalIdx; c !== s && c >= 0; c = prev[c]) {
      const i = c % this.cols;
      cells.push(this.center(i, (c - i) / this.cols));
    }
    cells.reverse();
    cells[cells.length - 1] = goal;
    // 직선으로 갈 수 있는 중간점은 건너뛴다
    const out: P2[] = [];
    let anchor = start;
    for (let k = 0; k < cells.length; k++) {
      const next = cells[k + 1];
      if (next && this.lineFree(anchor, next)) continue;
      out.push(cells[k]);
      anchor = cells[k];
    }
    return out;
  }
}

/** 가구 바닥 윤곽(회전된 상자)을 r 만큼 부풀린 안에 p 가 있는가 */
function hitsBox({ e, b, c, s }: Box, p: P2, r: number): boolean {
  const dx = p.x - e.x, dy = p.y - e.y;
  const lx = c * dx + s * dy, ly = -s * dx + c * dy;      // 가구 로컬 좌표로 되돌림
  return lx > b.x0 - r && lx < b.x1 + r && ly > b.y0 - r && ly < b.y1 + r;
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number { return this.ids.length; }
  push(id: number, key: number): void {
    const a = this.ids, k = this.keys;
    a.push(id); k.push(key);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [a[p], a[i]] = [a[i], a[p]]; [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.ids, k = this.keys;
    const top = a[0];
    const lastId = a.pop()!, lastKey = k.pop()!;
    if (a.length) {
      a[0] = lastId; k[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && k[l] < k[m]) m = l;
        if (r < a.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}
