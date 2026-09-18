import * as THREE from "three";
import type { FacePosition, KidInfo, ServerMsg, StateMsg } from "../protocol";
import type { RibbonSocket } from "../ws";
import { Speaker } from "../speech/browserTts";
import { RibbonBrain } from "./brain";
import { Hud } from "./hud";
import { Ribbon3D } from "./ribbon3d";
import { fetchCatalog, Stage } from "./stage";
import { renderNow, SEATS, type WorldView } from "../world/types";

export interface TvOptions { debug: boolean; demo: boolean; mic: boolean }

/**
 * TV 모드: 3D 방 + 리본이 + 대기 순서 + 자막.
 * 아이들은 화면에 그리지 않는다. 리본이는 맵을 돌아다니다가 부르면(ribbon.state) 반응한다.
 */
export async function startTv(socket: RibbonSocket, opts: TvOptions): Promise<void> {
  const stage = new Stage(document.getElementById("app")!, await fetchCatalog());
  const hud = new Hud();
  const speaker = new Speaker(socket, { showLock: true });
  const { mountOutputPicker } = await import("./output");
  mountOutputPicker(speaker);
  const ribbon = new Ribbon3D();
  const brain = new RibbonBrain(ribbon);
  ribbon.root.visible = false;      // 길찾기가 준비되고 자리에 세울 때까지
  stage.scene.add(ribbon.root);
  const bubble = document.getElementById("bubble")!;

  let kids: KidInfo[] = [];
  let faces: FacePosition[] = [];
  let facesAt = 0;
  let placed = false;
  let walkSpeed = 1;

  speaker.onLevel = (v) => ribbon.setMouthLevel(v);
  speaker.onStart = (m) => { hud.showCaption(m.text, 2000 + m.text.length * 250); };

  // 걷는 속도는 인형 키에 비례 (키 2.4 → 초당 약 0.9 단위 ≈ 0.4m)
  const applySpeed = () => { ribbon.speed = Math.max(0.6, ribbon.height * 0.38) * walkSpeed; };

  /** 길찾기 격자를 다시 만든다. toHome 이면 "부르면 오는 자리"에 다시 세운다 (처음, 방이 바뀔 때) */
  async function rebuildNav(toHome: boolean): Promise<void> {
    await ribbon.loaded;
    applySpeed();
    brain.nav = stage.buildNav(ribbon.radius, ribbon.height);
    brain.arts = stage.room.artSpots;
    brain.chairs = (stage.room.layout?.items ?? []).filter((e) => e.type in SEATS);
    brain.unitPerM = stage.room.U;
    const spot = stage.room.layout?.doll_spot;
    if (spot) brain.home = { x: spot.x, y: spot.y };
    brain.reset(toHome || !placed);
    placed = true;
    ribbon.root.visible = true;
  }

  let applying = Promise.resolve();
  let world: WorldView | null = null;      // 마지막으로 받은 방 (시간대가 바뀌면 배경만 다시 고른다)
  let bgNow = "";
  function applyWorld(s: StateMsg): void {
    const w = s.config?.world;
    if (!w) return;
    world = w;
    const render = renderNow(w.render);
    applying = applying.then(async () => {
      if (placed && w.room !== stage.room.roomId) {
        // 다른 방으로: 새 방을 다 읽을 때까지 리본이를 멈추고 숨긴다 (옛 방 길로 걷지 않게)
        placed = false;
        ribbon.stop();
        ribbon.root.visible = false;
      }
      bgNow = render?.bg ?? "";
      const { changed, roomChanged } = await stage.setWorld(w.room, w.layout, render);
      if (changed || !placed) await rebuildNav(roomChanged || !placed);
    }).catch((e) => { console.error("맵 적용 실패", e); placed = true; ribbon.root.visible = true; });
  }
  // 시간대(일출·아침·낮·일몰·밤)가 바뀌면 배경과 조명만 슬쩍 갈아 끼운다
  setInterval(() => {
    if (!world || !placed) return;
    const render = renderNow(world.render);
    if (!render?.bg || render.bg === bgNow) return;
    bgNow = render.bg;
    const w = world;
    applying = applying.then(() => stage.setWorld(w.room, w.layout, render).then(() => undefined))
      .catch((e) => console.error("시간대 배경 바꾸기 실패", e));
  }, 60000);
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { if (placed) void rebuildNav(false); }, 300);
  });

  function applyState(s: StateMsg): void {
    kids = s.kids;
    applyWorld(s);
    const rc = s.config?.ribbon;
    if (rc) {
      ribbon.setLook(rc.look);
      brain.opts = { wander: rc.wander ?? true, returnAfterS: rc.return_after_s ?? 8 };
      walkSpeed = rc.walk_speed ?? 1;
      applySpeed();
    }
    hud.setQueue(s.queue, kids);
    brain.setState(s.ribbon);
  }

  socket.on((msg: ServerMsg) => {
    switch (msg.type) {
      case "state": applyState(msg); break;
      case "ribbon.state": brain.setState(msg.state); break;
      case "speak": speaker.enqueue(msg); break;
      case "transcript": {
        const name = kids.find((k) => k.id === msg.kid_id)?.name ?? "친구";
        hud.showCaption(`${name}: ${msg.text}`, 4000);
        break;
      }
      case "face.positions": faces = msg.faces; facesAt = performance.now(); break;
      case "kid.enter": brain.celebrate(); break;   // 반가워하기. state 스냅샷이 뒤따라온다
      case "kid.leave": brain.farewell(); break;    // 아쉬운 표정
    }
  });

  // 카메라 폰이 본 얼굴 → TV 앞 공간의 한 점 (화면 왼쪽 얼굴이면 카메라 왼쪽)
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  function faceTarget(): THREE.Vector3 | null {
    if (!faces.length || performance.now() - facesAt > 1500) return null;
    const f = faces.reduce((a, b) => (Math.abs(a.x - 0.5) < Math.abs(b.x - 0.5) ? a : b));
    stage.camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
    const span = stage.room.U * 1.5;
    return stage.camera.position.clone().addScaledVector(right, (f.x - 0.5) * span).addScaledVector(up, (0.5 - f.y) * span * 0.6);
  }

  const clock = new THREE.Clock();
  const head = new THREE.Vector3();
  function frame(): void {
    const dt = Math.min(clock.getDelta(), 0.1);
    brain.viewer.copy(stage.camera.position);
    brain.faceTarget = faceTarget();
    if (placed) brain.update(dt);
    stage.followShadow(ribbon.root.position);
    stage.render();
    // 말풍선: 듣는 중 / 생각 중
    const s = ribbon.state;
    const text = s === "listening" ? "👂" : s === "thinking" ? "💭" : "";
    if (text && placed) {
      const p = stage.toScreen(ribbon.headTop(head));
      bubble.textContent = text;
      bubble.style.display = p.visible ? "block" : "none";
      bubble.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -110%)`;
      bubble.classList.toggle("thinking", s === "thinking");
    } else {
      bubble.style.display = "none";
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  if (opts.mic && !opts.debug) {
    // 마이크가 TV 노트북에 꽂혀 있을 때: 오른쪽 아래 작은 마이크 칸 (m 키로 숨기기)
    const { mountMicControl } = await import("../audio/micControl");
    const box = document.createElement("div");
    box.className = "overlay";
    box.style.cssText = "right:16px;bottom:16px;width:280px";
    document.body.appendChild(box);
    mountMicControl(box, socket, { autoStart: true, compact: true });
    window.addEventListener("keydown", (e) => { if (e.key === "m") box.hidden = !box.hidden; });
  }
  if (opts.debug) {
    const { mountDebugPanel } = await import("../debug/panel");
    mountDebugPanel(socket, () => kids);
    (window as unknown as { __ribbon: unknown }).__ribbon = { stage, ribbon, brain, speaker, kids: () => kids, THREE };
  }
  if (opts.demo) {
    setTimeout(() => {
      kids.filter((k) => !k.present).forEach((k, i) => setTimeout(() => socket.sendJson({ type: "kid.enter", kid_id: k.id }), i * 4000));
    }, 1500);
  }
}
