import { Assets, Container, Sprite, Texture } from "pixi.js";
import { Projection } from "./projection";
import type { RoomLayer, RoomSpec } from "./spec";

/**
 * RoomSpec 을 PNG 스프라이트 레이어로 그린다. TV 와 관리자 미리보기가 같이 쓴다.
 * - back / floor / front: 배열 순서대로
 * - world: 각 레이어를 컨테이너에 넣고 y = sortY 로 두어(pivot 으로 보정) 아바타와 함께 y 정렬
 */
export class RoomView {
  readonly back = new Container();
  readonly floor = new Container();
  readonly world = new Container();
  readonly front = new Container();
  spec: RoomSpec;
  proj: Projection;
  private nodes = new Map<string, Container>();
  private textures = new Map<string, Texture>();
  private version = 0;

  constructor(spec: RoomSpec) {
    this.spec = spec;
    this.proj = new Projection(spec.perspective, spec.view.w);
    this.world.sortableChildren = true;
  }

  get seats() { return this.spec.anchors.seats; }
  get door() { return this.spec.anchors.door; }
  get ribbonSpot() { return this.spec.anchors.ribbon; }
  get avatarBase() { return this.spec.scale.avatar; }
  get ribbonBase() { return this.spec.scale.ribbon; }

  /** 전체 교체. 텍스처는 캐시하고, 스프라이트는 다시 만든다 */
  async setSpec(spec: RoomSpec): Promise<void> {
    this.spec = spec;
    this.proj = new Projection(spec.perspective, spec.view.w);
    const v = ++this.version;
    const files = [...new Set(spec.layers.map((l) => l.file))];
    await Promise.all(files.map((f) => this.loadTexture(f)));
    if (v !== this.version) return; // 그 사이 다른 setSpec 이 들어옴
    for (const n of this.nodes.values()) n.parent?.removeChild(n);
    this.nodes.clear();
    for (const l of spec.layers) {
      if (l.visible === false) continue;
      const node = this.makeNode(l);
      if (node) this.nodes.set(l.id, node);
    }
  }

  /** 드래그 중 위치만 갱신 (텍스처 재로딩 없음) */
  place(layer: RoomLayer): void {
    const node = this.nodes.get(layer.id);
    if (!node) return;
    this.applyPlacement(node, layer);
  }

  node(id: string): Container | undefined { return this.nodes.get(id); }

  private async loadTexture(file: string): Promise<void> {
    if (this.textures.has(file)) return;
    try {
      const tex = await Assets.load<Texture>({ src: file, parser: "loadTextures" });
      tex.source.scaleMode = "nearest";
      this.textures.set(file, tex);
    } catch (e) {
      console.warn("room texture load failed", file, e);
    }
  }

  private makeNode(l: RoomLayer): Container | null {
    const tex = this.textures.get(l.file);
    if (!tex) return null;
    const sprite = new Sprite(tex);
    sprite.label = l.id;
    const node = new Container();
    node.label = l.id;
    node.addChild(sprite);
    this.applyPlacement(node, l);
    const parent = { back: this.back, floor: this.floor, world: this.world, front: this.front }[l.layer];
    parent.addChild(node);
    return node;
  }

  private applyPlacement(node: Container, l: RoomLayer): void {
    const sprite = node.children[0] as Sprite;
    const sc = l.scale ?? 1;
    sprite.scale.set(l.flip ? -sc : sc, sc);
    sprite.x = l.flip ? l.x + sprite.texture.width * sc : l.x;
    sprite.y = l.y;
    const bottom = l.y + sprite.texture.height * sc;
    const sortY = l.layer === "world" ? (l.sortY ?? bottom) : 0;
    // world 는 매 프레임 zIndex = y 로 정렬하므로, 컨테이너 y 를 sortY 로 두고 pivot 으로 그림 위치를 보정한다
    node.y = sortY;
    node.pivot.y = sortY;
    node.zIndex = sortY;
  }
}
