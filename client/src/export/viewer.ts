import * as THREE from "three";
import { bgOf, composeArt, padOf } from "../world/artimage";
import { filterCanvas, fxOf } from "../world/artfx";
import { buildFrame, frameStyle } from "../world/frames";
import { buildGuide, guideOf, type Guide, type GuideModel } from "../world/guide";

/**
 * 가져가는 전시실 (.html 한 장, 2026-09-21).
 *
 * 학원을 그만두는 아이에게 통째로 줄 수 있게, 서버 없이 폰에서 열리는 **파일 하나**로 만든다.
 * 서버(main.api_kid_export)가 이 파일의 자바스크립트와 그림·배경을 모두 data: 주소로 박아 넣은 HTML 을 만들고,
 * 여기서는 `window.__GALLERY__` 에 담긴 값만 보고 그린다 (인터넷·서버 없이 그대로 열린다).
 *   - **전시실** 탭: 방 가운데에서 쓸어 넘겨 둘러본다 (배경은 구워 둔 360° 파노라마, 그림·액자는 실시간)
 *   - **작품 목록** 탭: 벽에 걸지 않은 것까지 모든 작품
 *   - 작품을 누르면 크게 보고, 이름·완성일·이야기를 읽고, 내려받는다
 * 3D 가 안 되는 기기(WebGL 없음)에서는 작품 목록만 보여 준다.
 */

interface ExportArt {
  image: string; width: number; aspect: number; frame?: string;
  mount: { host: string | null; id: string }; u?: number; v?: number;
  bg?: string; pad?: number[]; fx?: Record<string, number>;
}
interface Mount { id: string; name: string; origin: number[]; normal: number[]; up: number[]; width: number; height: number }
interface ExportData {
  kid: string;
  made: string;
  room: { unit_per_m: number; front_y: number; back_y: number; mounts: Mount[] };
  halls: { light: number; pano: string | null; guide?: Partial<Guide> | null; arts: ExportArt[] }[];
  guides: Record<string, string>;           // 세워 둔 캐릭터의 glb (data: 주소)
  artworks: { file: string; name: string; made?: string; note?: string; bg?: string; pad?: number[]; width: number; height: number }[];
  images: Record<string, string>;
}

const LOOK_EYE_M = 1.9, LOOK_BACK = 0.18;     // 서버 world_render 와 같은 자리 (파노라마를 찍은 곳)
const LOOK_YAW = Math.PI / 2, LOOK_PITCH = 0.56;

const data = (window as unknown as { __GALLERY__: ExportData }).__GALLERY__;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
/** 블렌더 좌표(x, y, z) -> three 좌표 */
const b2t = (v: ArrayLike<number>): THREE.Vector3 => new THREE.Vector3(v[0], v[2], -v[1]);
const src = (file: string): string => data.images[file] ?? "";

let hall = 0;
let big: { art: ExportData["artworks"][0] | undefined; img: HTMLImageElement; fx: Record<string, number> } | null = null;
let bigBox: HTMLElement;
let bigCv: HTMLCanvasElement;
let bgIn: HTMLInputElement;

function showTab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll<HTMLElement>("[data-page]").forEach((el) => { el.hidden = el.dataset.page !== name; });
  if (name === "room") resize();
}

/** 파일을 열면 여기서 시작한다 (모든 선언이 끝난 맨 아래에서 부른다) */
function main(): void {
  document.title = `${data.kid}의 전시실`;
  document.body.innerHTML = PAGE();
  $("#title").textContent = `${data.kid}의 전시실`;
  bigBox = $("#big");
  bigCv = $<HTMLCanvasElement>("#big-cv");
  bgIn = $<HTMLInputElement>("#big-bg");
  bindBig();

  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
    b.onclick = () => showTab(b.dataset.tab!);
  });

  // ---------- 작품 목록 (벽에 걸지 않은 것까지) ----------
  $("#list").innerHTML = data.artworks.map((a) => `<button class="card" data-file="${esc(a.file)}">
    <img src="${src(a.file)}" alt="" style="background:${bgOf(a)}">
    <b>${esc(a.name)}</b>${a.made ? `<span>${esc(a.made.replace(/-/g, ". "))}</span>` : ""}</button>`).join("");
  $("#list").querySelectorAll<HTMLElement>("[data-file]").forEach((el) => {
    el.onclick = () => openBig(el.dataset.file!);
  });

  // ---------- 3D 전시실 ----------
  let renderer: THREE.WebGLRenderer | null = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch { renderer = null; }
  if (!renderer) {                                // 3D 를 못 그리는 기기: 작품 목록만
    $("#tab-room").hidden = true;
    showTab("list");
    return;
  }
  startRoom(renderer);
  showTab("room");
}

function startRoom(gl: THREE.WebGLRenderer): void {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.1, 500);
  gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  gl.toneMapping = THREE.NeutralToneMapping;
  $("#view").appendChild(gl.domElement);
  gl.domElement.style.touchAction = "none";
  scene.add(new THREE.HemisphereLight(0xffffff, 0xcdbba8, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(6, 20, 12);
  scene.add(sun);

  const ball = panoBall();
  scene.add(ball);
  let guideModel: GuideModel | null = null;
  const group = new THREE.Group();
  scene.add(group);
  const U = data.room.unit_per_m;
  const eye = new THREE.Vector3(0, LOOK_EYE_M * U, -((data.room.front_y + data.room.back_y) / 2
    - LOOK_BACK * Math.abs(data.room.back_y - data.room.front_y)));
  let yaw = 0, pitch = 0, fov = 68;

  function look(): void {
    camera.position.copy(eye);
    camera.rotation.set(pitch, yaw, 0, "YXZ");
    camera.fov = fov;
    camera.updateProjectionMatrix();
    ball.position.copy(eye);
  }

  /** 이 실의 그림을 모두 짓는다 (액자는 world/frames.ts, 그림면은 배경색·여백·필터까지 합쳐서) */
  function build(): void {
    for (const o of [...group.children]) {
      group.remove(o);
      o.traverse((m) => {
        const mesh = m as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | undefined;
        if (mat && !Array.isArray(mat)) mat.dispose();
      });
    }
    const light = data.halls[hall].light ?? 1;
    gl.toneMappingExposure = light;
    (ball.material as THREE.ShaderMaterial).uniforms.level.value = light;
    const pano = data.halls[hall].pano;
    ball.visible = !!pano;
    if (pano) setPano(ball, pano);
    void showGuide(scene);
    for (const a of data.halls[hall].arts) {
      const m = data.room.mounts.find((x) => x.id === a.mount.id);
      if (!m || a.mount.host) continue;           // 가구에 올린 그림은 빼고 (전시실에는 벽뿐이다)
      const mm = (v: number): number => (v / 1000) * U;
      const w = a.width * U, h = w * a.aspect;
      const g = new THREE.Group();
      const frame = buildFrame(w, h, frameStyle(a.frame), mm);
      g.add(...frame.meshes, frame.shade);
      const pic = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: artTexture(a), toneMapped: false }));
      pic.position.z = frame.pictureZ + mm(1);
      g.add(pic);
      const n = b2t(m.normal).normalize();
      let up = b2t(m.up).normalize();
      const right = new THREE.Vector3().crossVectors(up, n).normalize();
      up = new THREE.Vector3().crossVectors(n, right).normalize();
      const o = b2t(m.origin);
      g.position.copy(o).addScaledVector(right, (a.u ?? 0) * U).addScaledVector(up, (a.v ?? 1.5) * U);
      g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, n));
      g.userData.image = a.image;
      group.add(g);
    }
  }

  /** 이 실에 세워 둔 캐릭터 (glb 도 파일 안에 들어 있다) */
  async function showGuide(scene: THREE.Scene): Promise<void> {
    const g = guideOf(data.halls[hall].guide);
    if (guideModel && (!g || guideModel.group.userData.who !== g.who)) {
      scene.remove(guideModel.group);
      guideModel = null;
    }
    if (!g || !data.guides?.[g.who]) return;
    if (!guideModel) {
      try {
        guideModel = await buildGuide(g, data.guides[g.who]);
      } catch { return; }
      guideModel.group.userData.who = g.who;
      scene.add(guideModel.group);
    }
    guideModel.place(g);
  }

  // ---- 쓸어서 둘러보기 ----
  const el = gl.domElement;
  let last: { x: number; y: number } | null = null, moved = 0, vel = 0, pinch = 0;
  const points = new Map<number, { x: number; y: number }>();
  const span = (): number => 2 * Math.atan(Math.tan((fov * Math.PI / 180) / 2) * camera.aspect);
  el.onpointerdown = (ev) => {
    points.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    last = { x: ev.clientX, y: ev.clientY };
    moved = 0;
    vel = 0;
    el.setPointerCapture(ev.pointerId);
  };
  el.onpointermove = (ev) => {
    const p = points.get(ev.pointerId);
    if (!p || !last) return;
    const dx = ev.clientX - p.x, dy = ev.clientY - p.y;
    p.x = ev.clientX;
    p.y = ev.clientY;
    if (points.size >= 2) {                        // 두 손가락: 당겨 보기
      const ps = [...points.values()];
      const d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
      if (pinch > 0 && d > 0) fov = Math.min(88, Math.max(24, fov * (pinch / d)));
      pinch = d;
      look();
      return;
    }
    moved += Math.abs(dx) + Math.abs(dy);
    const per = Math.max(span(), 1.4) / Math.max(1, el.clientWidth);
    yaw = Math.min(LOOK_YAW, Math.max(-LOOK_YAW, yaw + dx * per));
    pitch = Math.min(LOOK_PITCH, Math.max(-LOOK_PITCH, pitch + dy * per));
    vel = dx * per * 12;
    look();
  };
  const done = (ev: PointerEvent): void => {
    points.delete(ev.pointerId);
    pinch = 0;
    if (points.size || !last) return;
    if (moved < 6) tap(ev);                        // 끌지 않고 눌렀다: 작품이면 크게 본다
    last = null;
  };
  el.onpointerup = done;
  el.onpointercancel = done;
  el.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    fov = Math.min(88, Math.max(24, fov * (ev.deltaY > 0 ? 1.08 : 0.92)));
    look();
  }, { passive: false });

  const ray = new THREE.Raycaster();
  function tap(ev: PointerEvent): void {
    const r = el.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1,
                                        -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
    for (const hit of ray.intersectObject(group, true)) {
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
        if (o.userData.image) { openBig(o.userData.image as string); return; }
      }
    }
  }

  // ---- 실 고르기 ----
  const halls = $("#halls");
  if (data.halls.length > 1) {
    halls.innerHTML = data.halls.map((_, i) => `<button data-hall="${i}" class="${i ? "" : "on"}">${i + 1}실</button>`).join("");
    halls.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.onclick = () => {
        hall = Number(b.dataset.hall);
        halls.querySelectorAll("button").forEach((o) => o.classList.toggle("on", o === b));
        build();
      };
    });
  }

  function resizeNow(): void {
    const w = $("#view").clientWidth, h = $("#view").clientHeight;
    if (!w || !h) return;
    gl.setSize(w, h);
    camera.aspect = w / h;
    if (camera.aspect < 1) fov = Math.max(fov, 84);   // 세로로 든 폰: 벽이 좁게 잘리지 않게 넓게
    look();
  }
  resize = resizeNow;
  window.addEventListener("resize", resizeNow);
  build();
  resizeNow();
  const loop = (): void => {
    requestAnimationFrame(loop);
    guideModel?.update(0.016);
    if (!points.size && Math.abs(vel) > 0.02) {    // 놓은 뒤 조금 더 돌다 멈춘다
      yaw = Math.min(LOOK_YAW, Math.max(-LOOK_YAW, yaw + vel * 0.016));
      vel *= 0.92;
      look();
    }
    gl.render(scene, camera);
  };
  loop();
}

let resize = (): void => { /* 3D 를 쓸 때 채운다 */ };

/** 그림면 그림: 배경색·여백·필터까지 합쳐 하나의 그림으로 (걸렸을 때 보이는 그대로) */
function artTexture(a: ExportArt): THREE.Texture {
  const tex = new THREE.Texture();
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const img = new Image();
  img.onload = () => {
    const c = composeArt(img, img.naturalWidth, img.naturalHeight, a, 2048);
    tex.image = filterCanvas(c, fxOf(a.fx));
    tex.needsUpdate = true;
  };
  img.src = src(a.image);
  return tex;
}

/** 파노라마를 입힌 공 (카메라를 따라다니며 맨 뒤에) */
function panoBall(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, level: { value: 1 } },
    vertexShader: `varying vec3 vDir;
      void main() { vDir = (modelMatrix * vec4(position, 0.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D map; uniform float level; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
        gl_FragColor = vec4(texture2D(map, uv).rgb * level, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 32), mat);
  ball.renderOrder = -100;
  ball.frustumCulled = false;
  return ball;
}

function setPano(ball: THREE.Mesh, url: string): void {
  const mat = ball.material as THREE.ShaderMaterial;
  if (mat.userData.url === url) return;
  mat.userData.url = url;
  const img = new Image();
  img.onload = () => {
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    mat.uniforms.map.value = tex;
  };
  img.src = url;
}

// ---------- 크게 보기 ----------
const safe = (t: string): string => t.replace(/[\\/:*?"<>|]/g, "_");

function openBig(file: string): void {
  const art = data.artworks.find((x) => x.file === file);
  const hung = data.halls.flatMap((h) => h.arts).find((x) => x.image === file);
  const img = new Image();
  img.onload = () => {
    big = { art, img, fx: hung?.fx ?? {} };
    bgIn.value = bgOf(art);
    paintBig();
    $("#big-name").textContent = art?.name ?? "";
    $("#big-made").textContent = art?.made ? `${art.made.replace(/-/g, ". ")} 완성` : "";
    $("#big-note").textContent = art?.note ?? "";
    $("#big-note").hidden = !art?.note;
    const raw = $<HTMLAnchorElement>("#big-raw");
    raw.href = src(file);
    raw.download = `${safe(data.kid)}_${safe(art?.name ?? "작품")}_원본.${file.split(".").pop() ?? "png"}`;
    bigBox.classList.add("open");
  };
  img.src = src(file);
}

function paintBig(): void {
  if (!big) return;
  const c = filterCanvas(composeArt(big.img, big.img.naturalWidth, big.img.naturalHeight,
                                    { bg: bgIn.value, pad: padOf(big.art) }), fxOf(big.fx));
  bigCv.width = c.width;
  bigCv.height = c.height;
  bigCv.getContext("2d")!.drawImage(c, 0, 0);
}
function bindBig(): void {
  bgIn.oninput = paintBig;
  $("#big-save").onclick = () => {
    if (!big) return;
    bigCv.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${safe(data.kid)}_${safe(big!.art?.name ?? "작품")}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, "image/png");
  };
  const closeBig = (): void => bigBox.classList.remove("open");
  $("#big-close").onclick = closeBig;
  bigBox.onclick = (ev) => { if (ev.target === bigBox || ev.target === bigCv.parentElement) closeBig(); };
  window.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeBig(); });
}

function PAGE(): string {
  return `
<style>
  :root { color-scheme: dark }
  html, body { height:100%; margin:0; background:#0e0b16; overflow:hidden }
  body { font:15px/1.5 system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; color:#f3efe9 }
  button, a.btn { font:inherit; font-size:14px; height:30px; padding:0 12px; border:1px solid #4a4356; border-radius:8px;
                  background:#241f2b; color:#f3efe9; cursor:pointer; text-decoration:none; display:inline-flex;
                  align-items:center; justify-content:center }
  button.on, a.btn.on { background:#e9557d; border-color:#e9557d; color:#fff }
  header { position:fixed; z-index:3; top:0; left:0; right:0; display:flex; gap:8px; align-items:center; flex-wrap:wrap;
           padding:10px 14px; background:linear-gradient(#0e0b16ee,#0e0b1600) }
  header h1 { font-size:16px; margin:0 6px 0 0 }
  .tabs, #halls { display:flex; gap:4px }
  main { position:fixed; inset:0 }
  #view { position:absolute; inset:0 }
  #view canvas { position:absolute; inset:0 }
  [data-page][hidden] { display:none }
  #list { position:absolute; inset:64px 0 0; overflow:auto; padding:8px 14px 24px; display:grid;
          grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:12px; align-content:start }
  .card { height:auto; flex-direction:column; align-items:stretch; gap:4px; padding:6px; text-align:left }
  .card img { width:100%; height:120px; object-fit:contain; border-radius:6px }
  .card b { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  .card span { font-size:11px; color:#c9bfd0 }
  #big { display:none; position:fixed; inset:0; z-index:5; background:rgba(8,6,12,.94); flex-direction:column }
  #big.open { display:flex }
  #big .show { flex:1; min-height:0; display:flex; flex-direction:column }
  #big .pic { flex:1; min-height:0; display:flex; align-items:center; justify-content:center; padding:12px; overflow:auto }
  #big canvas { max-width:100%; max-height:100%; object-fit:contain; box-shadow:0 2px 18px rgba(0,0,0,.5) }
  #big .note { flex:0 0 auto; max-height:34%; overflow:auto; padding:12px 16px; border-top:1px solid #2c2636; background:#12101a }
  #big .note h2 { font-size:17px; margin:0 0 2px }
  #big .note .when { font-size:13px; color:#c9bfd0 }
  #big .note p { margin:8px 0 0; white-space:pre-wrap; line-height:1.55 }
  #big .bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:12px 14px calc(12px + env(safe-area-inset-bottom)) }
  #big .bar label { display:flex; gap:6px; align-items:center; font-size:14px }
  #big-bg { width:40px; height:30px; padding:0; border:1px solid #4a4356; border-radius:6px; background:none }
  @media (orientation:landscape) {
    #big .show { flex-direction:row }
    #big .note { max-height:none; width:min(34%,360px); border-top:none; border-left:1px solid #2c2636 }
  }
</style>
<main>
  <div data-page="room"><div id="view"></div></div>
  <div data-page="list" hidden><div id="list"></div></div>
</main>
<header>
  <h1 id="title"></h1>
  <span class="tabs"><button data-tab="room" id="tab-room" class="on">전시실</button><button data-tab="list">작품 목록</button></span>
  <span id="halls"></span>
</header>
<div id="big">
  <div class="show">
    <div class="pic"><canvas id="big-cv"></canvas></div>
    <div class="note"><h2 id="big-name"></h2><div class="when" id="big-made"></div><p id="big-note"></p></div>
  </div>
  <div class="bar">
    <label>배경색 <input id="big-bg" type="color" value="#ffffff"></label>
    <button id="big-save" class="on">이 배경으로 받기</button>
    <a id="big-raw" class="btn" download>배경 없는 원본</a>
    <span style="flex:1"></span>
    <button id="big-close">닫기</button>
  </div>
</div>`;
}

main();
