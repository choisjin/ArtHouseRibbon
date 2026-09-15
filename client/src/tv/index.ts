import type { FacePosition, KidInfo, ServerMsg, StateMsg } from "../protocol";
import type { RibbonSocket } from "../ws";
import { Speaker } from "../speech/browserTts";
import { AvatarSprite } from "./avatar";
import { Hud } from "./hud";
import { RibbonSprite } from "./ribbon";
import { RoomScene, VIEW_H, VIEW_W, floorPoint, roomProjector } from "./scene";

export interface TvOptions { debug: boolean; demo: boolean }

/** TV 모드: 방 + 리본이 + 아바타 + 자막. 서버 메시지를 화면 상태로 바꾼다. */
export async function startTv(socket: RibbonSocket, opts: TvOptions): Promise<void> {
  const scene = new RoomScene();
  await scene.init(document.getElementById("app")!);
  const hud = new Hud();
  const speaker = new Speaker(socket);

  const ribbon = new RibbonSprite();
  const rp = floorPoint(scene.ribbonSpot);
  ribbon.x = Math.round(rp.x); ribbon.y = Math.round(rp.y);
  ribbon.scale.set(rp.s * scene.ribbonBase);
  scene.world.addChild(ribbon);

  const avatars = new Map<string, AvatarSprite>();
  let kids: KidInfo[] = [];
  let targetKid: string | null = null;
  let faces: FacePosition[] = [];
  let facesAt = 0;

  speaker.onLevel = (v) => ribbon.setMouthLevel(v);
  speaker.onStart = (m) => { hud.showCaption(m.text, 2000 + m.text.length * 250); };

  function ensureAvatar(kid: KidInfo): AvatarSprite {
    let a = avatars.get(kid.id);
    if (!a) {
      a = new AvatarSprite(kid, scene.door, roomProjector, scene.avatarBase);
      avatars.set(kid.id, a);
      scene.world.addChild(a);
      a.walkTo(scene.seats[(kid.seat ?? avatars.size - 1) % scene.seats.length]);
    }
    return a;
  }

  function removeAvatar(id: string): void {
    const a = avatars.get(id);
    if (!a) return;
    a.walkTo(scene.door, () => { scene.world.removeChild(a); avatars.delete(id); });
  }

  function applyState(s: StateMsg): void {
    kids = s.kids;
    for (const k of kids) {
      if (k.present) {
        const a = ensureAvatar(k);
        if (JSON.stringify(a.kid) !== JSON.stringify(k)) a.setKid(k);
      } else if (avatars.has(k.id)) removeAvatar(k.id);
    }
    for (const id of [...avatars.keys()]) if (!kids.some((k) => k.id === id)) removeAvatar(id); // 삭제된 아이
    ribbon.setColors(s.config?.ribbon?.colors);
    const active = s.queue.find((t) => t.state === "active");
    for (const a of avatars.values()) {
      a.handRaised = s.queue.some((t) => t.kid_id === a.kid.id && t.state === "waiting");
      a.talking = !!active && active.kid_id === a.kid.id && s.ribbon === "listening";
    }
    hud.setQueue(s.queue, kids);
    ribbon.setState(s.ribbon);
    targetKid = s.target_kid;
  }

  socket.on((msg: ServerMsg) => {
    switch (msg.type) {
      case "state": applyState(msg); break;
      case "ribbon.state": ribbon.setState(msg.state); targetKid = msg.target_kid; break;
      case "speak": speaker.enqueue(msg); break;
      case "transcript": {
        const name = kids.find((k) => k.id === msg.kid_id)?.name ?? "친구";
        hud.showCaption(`${name}: ${msg.text}`, 4000);
        break;
      }
      case "face.positions": faces = msg.faces; facesAt = performance.now(); break;
      case "kid.enter": case "kid.leave": break; // state 스냅샷이 뒤따라온다
    }
  });

  // 시선: 말하는 아이 아바타 > 카메라가 본 얼굴 > 두리번
  scene.app.ticker.add((t) => {
    const dt = t.deltaMS;
    const now = performance.now();
    const target = targetKid ? avatars.get(targetKid) : undefined;
    if (target) {
      const p = target.worldPos;
      ribbon.lookAt((p.x - ribbon.x) / (VIEW_W / 2), (p.y - 20 - ribbon.y) / (VIEW_H / 2));
    } else if (faces.length && now - facesAt < 1500) {
      const f = faces.reduce((a, b) => (Math.abs(a.x - 0.5) < Math.abs(b.x - 0.5) ? a : b));
      ribbon.lookAt((f.x - 0.5) * 2, (f.y - 0.5) * 1.2);
      scene.setParallax((f.x - 0.5) * 2);
    } else {
      ribbon.lookAround(now);
    }
    ribbon.update(dt);
    for (const a of avatars.values()) a.update(dt);
  });

  if (opts.debug) {
    const { mountDebugPanel } = await import("../debug/panel");
    mountDebugPanel(socket, () => kids);
    (window as unknown as { __ribbon: unknown }).__ribbon = { scene, avatars, ribbon, speaker, kids: () => kids };
  }
  if (opts.demo) {
    // 등원 연출 확인용: 접속 후 아이들을 차례로 입장시킨다
    setTimeout(() => {
      kids.filter((k) => !k.present).forEach((k, i) => setTimeout(() => socket.sendJson({ type: "kid.enter", kid_id: k.id }), i * 4000));
    }, 1500);
  }
}
