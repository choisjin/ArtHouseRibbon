import * as THREE from "three";
import type { FacePosition, KidInfo, ServerMsg, StateMsg } from "../protocol";
import type { RibbonSocket } from "../ws";
import { Speaker } from "../speech/browserTts";
import { RibbonBrain } from "./brain";
import { GameBoard } from "./game";
import { Hud } from "./hud";
import { MusicBar } from "./musicbar";
import { MusicList } from "./musiclist";
import { startImmersive } from "./immersive";
import { mountCallButton } from "./callbutton";
import { MusicPlayer } from "../music/player";
import { Ribbon3D } from "./ribbon3d";
import { fetchCatalog, Stage } from "./stage";
import { renderNow, SEATS, type WorldView } from "../world/types";

export interface TvOptions { debug: boolean; demo: boolean }

/**
 * TV 모드: 3D 방 + 리본이 + 대기 순서 + 자막.
 * 아이들은 화면에 그리지 않는다. 리본이는 맵을 돌아다니다가 부르면(ribbon.state) 반응한다.
 */
export async function startTv(socket: RibbonSocket, opts: TvOptions): Promise<void> {
  const stage = new Stage(document.getElementById("app")!, await fetchCatalog());
  const hud = new Hud();
  const speaker = new Speaker(socket, { showLock: true });
  const { startOutputAgent } = await import("./output");
  startOutputAgent(speaker, socket);   // 출력 장치는 관리자 '설정' 탭에서 고른다
  // 어떤 캐릭터로 나올지는 관리자 설정에서 온다. 만들 때 정해야 해서 state 를 기다리지 않고 먼저 물어본다
  const cfg0 = await fetch("/api/config").then((r) => r.json()).catch(() => null);
  const character = String(cfg0?.ribbon?.character ?? "");
  const friendId = String(cfg0?.ribbon?.friend ?? "");
  const ribbon = new Ribbon3D(character);
  const brain = new RibbonBrain(ribbon);
  ribbon.root.visible = false;      // 길찾기가 준비되고 자리에 세울 때까지
  stage.scene.add(ribbon.root);

  // 친구 캐릭터: 부르지 않아도 알아서 돌아다니기만 한다 (대화는 리본이 몫)
  const friend = friendId ? new Ribbon3D(friendId) : null;
  const friendBrain = friend ? new RibbonBrain(friend) : null;
  if (friend && friendBrain) {
    friend.root.visible = false;
    stage.scene.add(friend.root);
    friendBrain.avoid = ribbon;         // 리본이와 겹치지 않게 비켜 다닌다 (양보는 친구 쪽이)
    friendBrain.yields = true;
    brain.avoid = friend;               // 리본이는 친구가 있는 쪽을 목적지로 고르지 않는다
  }
  // 자동 확인용 (?probe=1): 캐릭터·길찾기를 밖에서 들여다본다 (겹침 검사 등)
  if (new URLSearchParams(location.search).has("probe")) {
    (window as unknown as Record<string, unknown>).__probe = { ribbon, friend, brain, friendBrain };
  }
  const bubble = document.getElementById("bubble")!;

  let kids: KidInfo[] = [];
  let faces: FacePosition[] = [];
  let facesAt = 0;
  const game = new GameBoard();
  const musicBar = new MusicBar();
  const musicList = new MusicList();
  startImmersive();                  // 주소창 없이 화면 가득 + 화면 꺼짐 막기
  mountCallButton(socket);           // 화면에서 리본이 부르기 (폰에서는 DJI 버튼을 쓸 수 없다)
  new MusicPlayer(socket, "tv", "리본 TV");   // 관리자 설정의 '재생할 곳'이 TV 면 이 화면이 Spotify 스피커
  const micBadge = document.getElementById("mic-badge")!;
  let placed = false;
  let walkSpeed = 1;

  speaker.onLevel = (v) => ribbon.setMouthLevel(v);
  // 자막은 TV 에 띄우지 않는다 (2026-09-21 요청). 대화 내용은 관리자 대시보드에만 남는다

  // 걷는 속도는 인형 키에 비례 (키 2.4 → 초당 약 0.9 단위 ≈ 0.4m)
  const applySpeed = () => { ribbon.speed = Math.max(0.6, ribbon.height * 0.38) * walkSpeed; };

  /** 길찾기 격자를 다시 만든다. toHome 이면 "부르면 오는 자리"에 다시 세운다 (처음, 방이 바뀔 때) */
  async function rebuildNav(toHome: boolean): Promise<void> {
    await Promise.all([ribbon.loaded, friend?.loaded]);
    applySpeed();
    // 두 캐릭터가 같은 격자를 쓰므로 더 큰 몸(머리·머리카락까지)에 맞춘다
    brain.nav = stage.buildNav(Math.max(ribbon.radius, friend?.radius ?? 0), Math.max(ribbon.height, friend?.height ?? 0));
    brain.arts = stage.room.artSpots;
    brain.chairs = (stage.room.layout?.items ?? []).filter((e) => e.type in SEATS);
    brain.unitPerM = stage.room.U;
    const spot = stage.room.layout?.doll_spot;
    if (spot) brain.home = { x: spot.x, y: spot.y };
    if (friendBrain && friend) {
      friendBrain.nav = brain.nav;
      friendBrain.arts = brain.arts;
      friendBrain.chairs = brain.chairs;
      friendBrain.unitPerM = brain.unitPerM;
      // 친구는 리본이 자리에서 조금 떨어진 곳을 제 자리로 삼는다
      const spot2 = brain.nav?.nearestFree({ x: brain.home.x + 2.2, y: brain.home.y + 1.2 });
      friendBrain.home = spot2 ?? brain.home;
      friend.speed = Math.max(0.6, friend.height * 0.38) * walkSpeed;
      friendBrain.reset(toHome || !placed);
      friend.root.visible = true;
    }
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
      // 캐릭터를 바꾸면 모델부터 다시 읽어야 해서 화면을 새로 연다 (관리자가 가끔 하는 일)
      if (String(rc.character ?? "") !== character || String(rc.friend ?? "") !== friendId) {
        location.reload();
        return;
      }
      ribbon.setLook(rc.look);
      const fp = friendId ? s.config?.characters?.[friendId] : undefined;
      if (friend && fp) friend.setLook(fp.look);   // 친구는 자기 프로필의 옷을 입는다
      brain.opts = { wander: rc.wander ?? true, returnAfterS: rc.return_after_s ?? 8 };
      if (friendBrain) friendBrain.opts = { wander: true, returnAfterS: 8 };
      walkSpeed = rc.walk_speed ?? 1;
      applySpeed();
      if (friend) friend.speed = Math.max(0.6, friend.height * 0.38) * walkSpeed;
    }
    hud.setQueue(s.queue, kids);
    brain.setState(s.ribbon);
  }

  socket.on((msg: ServerMsg) => {
    switch (msg.type) {
      case "state": applyState(msg); break;
      case "ribbon.state": brain.setState(msg.state); break;
      case "speak": speaker.enqueue(msg); break;
      case "speak.stop": speaker.stop(); break;
      case "cue": speaker.chime(); break;   // 불렀을 때 "띵" (듣고 있어)
      case "game": game.render(msg.view); break;   // 포켓몬 맞추기
      case "music.state": musicBar.render(msg); break;   // 음악 상태바
      case "music.list": musicList.render(msg.view); break;   // "플레이리스트 보여줘" 번호 목록
      case "mic": micBadge.classList.toggle("on", msg.on); break;   // 말할 수 있을 때 오른쪽 위 마이크
      case "face.positions": faces = msg.faces; facesAt = performance.now(); break;   // 카메라(관리자 페이지)가 초당 10번
      case "kid.enter": brain.celebrate(); break;   // 반가워하기. state 스냅샷이 뒤따라온다
      case "kid.leave": brain.farewell(); break;    // 아쉬운 표정
    }
  });

  // 카메라가 본 얼굴 → TV 앞 공간의 한 점 (화면 왼쪽 얼굴이면 카메라 왼쪽)
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
    // 카메라가 얼굴 목록(빈 목록 포함)을 계속 보내 오는 동안만 TV 앞에 몇 명인지 안다
    brain.audience = performance.now() - facesAt < 1500 ? faces.length : null;
    if (placed) {
      brain.update(dt);
      if (friendBrain) {
        friendBrain.viewer.copy(stage.camera.position);
        friendBrain.faceTarget = brain.faceTarget;
        friendBrain.audience = brain.audience;
        friendBrain.update(dt);
      }
    }
    stage.followShadow(ribbon.root.position);
    stage.render();
    // 말풍선: 생각 중 (귀 모양 "듣는 중"은 없앰 2026-09-20)
    const s = ribbon.state;
    const text = s === "thinking" ? "💭" : "";
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

  if (opts.debug) {
    const { mountDebugPanel } = await import("../debug/panel");
    mountDebugPanel(socket, () => kids);
    (window as unknown as { __ribbon: unknown }).__ribbon = { stage, ribbon, brain, friend, friendBrain, speaker, kids: () => kids, THREE };
  }
  if (opts.demo) {
    setTimeout(() => {
      kids.filter((k) => !k.present).forEach((k, i) => setTimeout(() => socket.sendJson({ type: "kid.enter", kid_id: k.id }), i * 4000));
    }, 1500);
  }
}
