import { Application, Container, Graphics, Rectangle, Text, type FederatedPointerEvent } from "pixi.js";
import type { KidInfo } from "../protocol";
import { AvatarSprite } from "../tv/avatar";
import { RibbonSprite } from "../tv/ribbon";
import { RoomView } from "../tv/room/view";
import type { FloorPos, RoomLayer, RoomSpec } from "../tv/room/spec";

/**
 * 관리자 "방 꾸미기": TV 와 같은 RoomView 위에서 가구 스프라이트와 앵커(자리·문·리본이)를 드래그해 배치한다.
 * 그림 자체는 PNG 파일(client/public/room, 또는 업로드)이고 여기서는 위치·순서·보임만 다룬다.
 */
type Api = <T>(method: string, url: string, body?: unknown) => Promise<T>;

interface EditorOpts {
  api: Api;
  getKids: () => KidInfo[];
  onMessage: (text: string, err?: boolean) => void;
}

const LAYER_LABEL: Record<string, string> = { back: "뒷벽/붙박이", floor: "바닥(러그)", world: "가구(앞뒤 정렬)", front: "카메라 앞" };

export async function mountRoomEditor(root: HTMLElement, opts: EditorOpts): Promise<{ setSpec(spec: RoomSpec): void }> {
  root.innerHTML = `
    <div class="room-editor">
      <div class="room-side">
        <div class="room-toolbar">
          <button id="rm-save" class="primary">저장</button>
          <button id="rm-reload">되돌리기</button>
          <button id="rm-reset" class="danger">기본값</button>
        </div>
        <label class="inline"><input type="checkbox" id="rm-anchors" /> 앵커 편집 (자리·문·리본이)</label>
        <label class="inline"><input type="checkbox" id="rm-chars" checked /> 캐릭터 보기</label>
        <h3>레이어</h3>
        <ul id="rm-layers"></ul>
        <div class="room-add">
          <input type="file" id="rm-add-file" accept="image/png,image/gif,image/webp" />
          <button id="rm-add">PNG 로 가구 추가</button>
        </div>
        <form id="rm-form" hidden>
          <label>이름 <input name="label" /></label>
          <label>파일 <input name="file" readonly /></label>
          <label>레이어 <select name="layer"><option value="back">뒷벽/붙박이</option><option value="floor">바닥(러그)</option><option value="world">가구(앞뒤 정렬)</option><option value="front">카메라 앞</option></select></label>
          <div class="row2">
            <label>x <input name="x" type="number" /></label>
            <label>y <input name="y" type="number" /></label>
          </div>
          <div class="row2">
            <label>앞뒤 기준선 y <input name="sortY" type="number" /></label>
            <label>배율 <input name="scale" type="number" step="0.05" min="0.1" max="4" /></label>
          </div>
          <label class="inline"><input name="flip" type="checkbox" /> 좌우 반전</label>
          <label class="inline"><input name="visible" type="checkbox" /> 보이기</label>
          <label>PNG 교체 <input name="replace" type="file" accept="image/png,image/gif,image/webp" /></label>
          <div class="actions">
            <button type="button" id="rm-up">↑ 뒤로</button>
            <button type="button" id="rm-down">↓ 앞으로</button>
            <button type="button" id="rm-delete" class="danger">삭제</button>
          </div>
        </form>
      </div>
      <div class="room-stage"><div id="rm-canvas"></div>
        <p class="hint">가구를 끌어서 옮기세요. 앵커 편집을 켜면 자리(1~4)·문·리본이 표식을 끌 수 있습니다. 바꾼 뒤 저장을 누르면 TV 에 바로 반영됩니다.</p>
      </div>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  let spec: RoomSpec = await opts.api<RoomSpec>("GET", "/api/room");
  let saved = JSON.stringify(spec);
  let selected: string | null = null;
  let anchorMode = false;
  let showChars = true;

  // ---- Pixi 스테이지 ----
  const view = new RoomView(spec);
  const app = new Application();
  const k = 1.4;
  await app.init({ width: spec.view.w * k, height: spec.view.h * k, background: 0x0e0b16, antialias: false, resolution: 1, roundPixels: true });
  $("#rm-canvas").appendChild(app.canvas);
  app.stage.scale.set(k);
  app.stage.eventMode = "static";
  app.stage.hitArea = new Rectangle(0, 0, spec.view.w, spec.view.h);
  app.stage.addChild(view.back, view.floor, view.world, view.front);
  const overlay = new Graphics();
  const markers = new Container();
  view.front.addChild(overlay, markers);
  app.ticker.add(() => { for (const c of view.world.children) c.zIndex = c.y; });

  // 캐릭터 미리보기
  const ribbon = new RibbonSprite();
  const avatars: AvatarSprite[] = [];
  view.world.addChild(ribbon);
  function placeChars(): void {
    const rp = view.proj.floorPoint(spec.anchors.ribbon);
    ribbon.x = Math.round(rp.x); ribbon.y = Math.round(rp.y); ribbon.scale.set(rp.s * spec.scale.ribbon);
    ribbon.visible = showChars;
    const kids = opts.getKids();
    while (avatars.length < spec.anchors.seats.length) {
      const i = avatars.length;
      const kid: KidInfo = kids[i] ?? { id: `p${i}`, name: `아이${i + 1}`, avatar: { hair: ["short", "bowl", "twin", "spiky"][i % 4] }, present: true };
      const a = new AvatarSprite(kid, spec.anchors.seats[i], { toScreen: (p) => view.proj.floorPoint(p) }, spec.scale.avatar);
      avatars.push(a); view.world.addChild(a);
    }
    avatars.forEach((a, i) => {
      a.visible = showChars && i < spec.anchors.seats.length;
      if (a.visible) { a.walkTo(spec.anchors.seats[i]); }
    });
  }
  app.ticker.add((t) => { ribbon.lookAround(performance.now()); ribbon.update(t.deltaMS); for (const a of avatars) a.update(t.deltaMS); });

  // ---- 스펙 적용 ----
  async function applySpec(): Promise<void> {
    await view.setSpec(spec);
    for (const l of spec.layers) bindNode(l);
    placeChars();
    renderList();
    renderForm();
    drawOverlay();
  }

  function bindNode(l: RoomLayer): void {
    const node = view.node(l.id);
    if (!node) return;
    node.eventMode = "static";
    node.cursor = "move";
    node.removeAllListeners();
    node.on("pointerdown", (e: FederatedPointerEvent) => {
      if (anchorMode) return;
      e.stopPropagation();
      select(l.id);
      const p = e.getLocalPosition(app.stage);
      drag = { kind: "layer", id: l.id, dx: p.x - l.x, dy: p.y - l.y, sortOff: (l.sortY ?? 0) - l.y };
    });
  }

  type Drag = { kind: "layer"; id: string; dx: number; dy: number; sortOff: number } | { kind: "anchor"; key: string; index: number } | null;
  let drag: Drag = null;
  // pointermove 는 포인터 아래 객체에만 오므로, 드래그 중에는 어디서든 오는 globalpointermove 를 쓴다
  app.stage.on("globalpointermove", (e: FederatedPointerEvent) => {
    if (!drag) return;
    const p = e.getLocalPosition(app.stage);
    if (drag.kind === "layer") {
      const d = drag;
      const l = spec.layers.find((x) => x.id === d.id);
      if (!l) return;
      l.x = Math.round(p.x - d.dx); l.y = Math.round(p.y - d.dy);
      if (l.layer === "world") l.sortY = l.y + d.sortOff;
      view.place(l); renderForm(); drawOverlay();
    } else {
      const fp = view.proj.unprojectFloor(p.x, p.y);
      if (!fp) return;
      const v: FloorPos = { bx: Math.round(fp.bx), t: Math.round(fp.t * 100) / 100 };
      if (drag.key === "seat") spec.anchors.seats[drag.index] = v;
      else if (drag.key === "door") spec.anchors.door = v;
      else spec.anchors.ribbon = v;
      placeChars(); drawOverlay();
    }
  });
  const endDrag = () => { drag = null; };
  app.stage.on("pointerup", endDrag);
  app.stage.on("pointerupoutside", endDrag);
  window.addEventListener("pointerup", endDrag);
  app.stage.on("pointerdown", () => { if (!anchorMode) { select(null); } });

  function select(id: string | null): void {
    selected = id;
    renderList(); renderForm(); drawOverlay();
  }

  function drawOverlay(): void {
    overlay.clear();
    markers.removeChildren();
    if (selected) {
      const l = spec.layers.find((x) => x.id === selected);
      const node = view.node(selected);
      if (l && node) {
        const b = node.getLocalBounds();
        overlay.rect(b.x, b.y + (l.layer === "world" ? 0 : 0), b.width, b.height).stroke({ width: 1, color: 0xffd54a });
        if (l.layer === "world" && l.sortY != null) overlay.moveTo(b.x - 6, l.sortY).lineTo(b.x + b.width + 6, l.sortY).stroke({ width: 1, color: 0x4aa3ff });
      }
    }
    if (!anchorMode) return;
    const mk = (pos: FloorPos, label: string, color: number, key: string, index: number) => {
      const p = view.proj.floorPoint(pos);
      const c = new Container();
      const g = new Graphics();
      g.ellipse(0, 0, 9, 4).fill({ color, alpha: 0.5 }).stroke({ width: 1, color });
      g.rect(-1, -18, 2, 18).fill(color);
      const t = new Text({ text: label, resolution: 3, style: { fontSize: 9, fill: 0xffffff, stroke: { color: 0x000000, width: 2 } } });
      t.anchor.set(0.5, 1); t.y = -20;
      c.addChild(g, t); c.x = p.x; c.y = p.y;
      c.eventMode = "static"; c.cursor = "grab"; c.hitArea = new Rectangle(-12, -26, 24, 32);
      c.on("pointerdown", (e: FederatedPointerEvent) => { e.stopPropagation(); drag = { kind: "anchor", key, index }; });
      markers.addChild(c);
    };
    spec.anchors.seats.forEach((s, i) => mk(s, `자리 ${i + 1}`, 0x4aa3ff, "seat", i));
    mk(spec.anchors.door, "문", 0xffa04a, "door", 0);
    mk(spec.anchors.ribbon, "리본이", 0xff7aa8, "ribbon", 0);
  }

  // ---- 목록 / 폼 ----
  function renderList(): void {
    const ul = $("#rm-layers");
    ul.innerHTML = "";
    for (const l of spec.layers) {
      const li = document.createElement("li");
      li.className = l.id === selected ? "sel" : "";
      li.innerHTML = `<span>${l.label ?? l.id}</span><small>${LAYER_LABEL[l.layer] ?? l.layer}${l.visible === false ? " · 숨김" : ""}</small>`;
      li.onclick = () => select(l.id);
      ul.appendChild(li);
    }
  }

  function renderForm(): void {
    const f = $("#rm-form") as HTMLFormElement;
    const l = spec.layers.find((x) => x.id === selected);
    f.hidden = !l;
    if (!l) return;
    const set = (n: string, v: string | boolean) => {
      const el = f.elements.namedItem(n) as HTMLInputElement;
      if (typeof v === "boolean") el.checked = v; else el.value = v;
    };
    set("label", l.label ?? ""); set("file", l.file); set("layer", l.layer);
    set("x", String(l.x)); set("y", String(l.y)); set("sortY", String(l.sortY ?? "")); set("scale", String(l.scale ?? 1));
    set("flip", !!l.flip); set("visible", l.visible !== false);
  }

  ($("#rm-form") as HTMLFormElement).oninput = async (e) => {
    const l = spec.layers.find((x) => x.id === selected);
    if (!l) return;
    const f = e.currentTarget as HTMLFormElement;
    const v = (n: string) => (f.elements.namedItem(n) as HTMLInputElement);
    const target = e.target as HTMLInputElement;
    if (target.name === "replace") {
      const file = target.files?.[0];
      if (!file) return;
      const fd = new FormData(); fd.append("file", file);
      try { const up = await opts.api<{ url: string }>("POST", "/api/assets", fd); l.file = up.url; await applySpec(); opts.onMessage("그림을 바꿨습니다"); }
      catch (err) { opts.onMessage(String(err), true); }
      return;
    }
    l.label = v("label").value; l.layer = v("layer").value as RoomLayer["layer"];
    l.x = Number(v("x").value) || 0; l.y = Number(v("y").value) || 0;
    l.sortY = v("sortY").value === "" ? undefined : Number(v("sortY").value);
    l.scale = Number(v("scale").value) || 1; l.flip = v("flip").checked; l.visible = v("visible").checked;
    if (target.name === "layer" || target.name === "visible" || target.name === "scale") await applySpec();
    else { view.place(l); drawOverlay(); renderList(); }
  };

  const move = async (delta: number) => {
    const i = spec.layers.findIndex((x) => x.id === selected);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= spec.layers.length) return;
    [spec.layers[i], spec.layers[j]] = [spec.layers[j], spec.layers[i]];
    await applySpec();
  };
  $("#rm-up").onclick = () => void move(-1);
  $("#rm-down").onclick = () => void move(1);
  $("#rm-delete").onclick = async () => {
    const l = spec.layers.find((x) => x.id === selected);
    if (!l || !confirm(`${l.label ?? l.id} 레이어를 지울까요? (그림 파일은 남습니다)`)) return;
    spec.layers = spec.layers.filter((x) => x.id !== l.id); selected = null; await applySpec();
  };
  $("#rm-add").onclick = async () => {
    const input = $("#rm-add-file") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) { opts.onMessage("먼저 PNG 파일을 고르세요", true); return; }
    const fd = new FormData(); fd.append("file", file);
    try {
      const up = await opts.api<{ url: string }>("POST", "/api/assets", fd);
      const id = `L${Date.now().toString(36)}`;
      spec.layers.push({ id, file: up.url, x: 280, y: 200, layer: "world", label: file.name.replace(/\.[^.]+$/, "") });
      selected = id; input.value = ""; await applySpec();
      const l = spec.layers.find((x) => x.id === id)!; const node = view.node(id);
      if (node) { l.sortY = l.y + node.getLocalBounds().height; view.place(l); drawOverlay(); renderForm(); }
    } catch (err) { opts.onMessage(String(err), true); }
  };

  ($("#rm-anchors") as HTMLInputElement).onchange = (e) => { anchorMode = (e.target as HTMLInputElement).checked; drawOverlay(); };
  ($("#rm-chars") as HTMLInputElement).onchange = (e) => { showChars = (e.target as HTMLInputElement).checked; placeChars(); };

  $("#rm-save").onclick = async () => {
    try { spec = await opts.api<RoomSpec>("PUT", "/api/room", spec); saved = JSON.stringify(spec); opts.onMessage("방 배치 저장됨 (TV 에 반영)"); await applySpec(); }
    catch (err) { opts.onMessage(String(err), true); }
  };
  $("#rm-reload").onclick = async () => { spec = JSON.parse(saved); selected = null; await applySpec(); opts.onMessage("저장된 상태로 되돌림"); };
  $("#rm-reset").onclick = async () => {
    if (!confirm("방 배치를 기본값으로 되돌릴까요?")) return;
    try { spec = await opts.api<RoomSpec>("POST", "/api/room/reset"); saved = JSON.stringify(spec); selected = null; await applySpec(); opts.onMessage("기본값으로 되돌림"); }
    catch (err) { opts.onMessage(String(err), true); }
  };
  window.addEventListener("beforeunload", (e) => { if (JSON.stringify(spec) !== saved) { e.preventDefault(); } });

  await applySpec();
  let kidsKey = "";
  return {
    setSpec(s: RoomSpec) {
      // 다른 곳(다른 탭)에서 저장된 경우, 여기서 고치는 중이 아니면 따라간다
      if (JSON.stringify(spec) === saved && JSON.stringify(s) !== saved) { spec = s; saved = JSON.stringify(s); void applySpec(); }
    },
    setKids(kids: KidInfo[]) {
      // 아이 명단이 오면 미리보기 아바타를 실제 아이 스프라이트로 다시 만든다
      const key = kids.map((k) => `${k.id}:${JSON.stringify(k.avatar)}`).join("|");
      if (key === kidsKey) return;
      kidsKey = key;
      for (const a of avatars) { view.world.removeChild(a); a.destroy(); }
      avatars.length = 0;
      placeChars();
    },
  };
}
