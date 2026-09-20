// 맵 편집기 (미술실 / 전시장, 가구 + 그림 + 리본이 "부르면 오는 자리")
// Character_Creator/tools/layout_editor/app.js 를 옮겨 온 것. 바뀐 점:
//   - 서버 API: /api/world, /api/world/layout, /api/artworks (리본 서버 main.py)
//   - 모델은 /world/ (tools/sync_world.py 가 가져옴), 블렌더 빌드/미리보기 버튼 없음
//   - "TV 에 보여주기" (서버 active 방), 인형 = 리본이 (관리자 페이지 겉모습 반영)
// 원본을 고치면 여기도 같이 맞춘다. 배치 파일 형식은 두 쪽이 같다.
// 좌표: layout 파일은 블렌더 장면 단위(Z 위, 정면 = -Y). three.js 는 Y 위라서 (x, y, z) → (x, z, -y)
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyLook } from '../world/doll';

const $ = (id) => document.getElementById(id);
const FLOOR_LAYER = new Set(['rug']);                 // 위에 다른 가구가 올라가도 되는 바닥 깔개
const TUCK_PAIRS = [['table', 'chair']];              // 서로 겹쳐도 되는 조합 (의자를 책상 밑으로 넣음)
const EPS = 0.02;
const FRAMES = { canvas: [0, 0, null], black: [20, 38, 0x1d1d1f], wood: [40, 42, 0xa8744a], white: [30, 38, 0xf6f5f1] };
const ART_DEPTH_MM = 30;

// ---------------- 서버 ----------------
async function sendJSON(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.detail || j.error || `요청 실패 (${r.status})`);
  return j;
}
const api = {
  state: (room) => sendJSON('GET', `/api/world?room=${room}`),
  save: (room, layout) => sendJSON('PUT', `/api/world/layout?room=${room}`, layout),
  setActive: (room) => sendJSON('PUT', '/api/world/active', { room }),
  render: (room) => sendJSON('POST', `/api/world/render?room=${room}`),
  renderStatus: () => sendJSON('GET', '/api/world/render'),
  config: () => sendJSON('GET', '/api/config'),
  upload: (body) => sendJSON('POST', '/api/artworks', body),
  deleteArt: (file) => sendJSON('POST', '/api/artworks/delete', { file }),
};
const MODEL_BASE = '/world/';

// ---------------- 상태 ----------------
let catalog = null, room = null, roomId = 'classroom', U = 2.2222;
const types = {};
let artworks = [];
let layout = { doll_spot: { x: 0, y: 0 }, items: [], storage: [], arts: [] };
let sel = null;                 // {kind: 'item' | 'doll' | 'art', id}
let placing = null;             // {file} 새 그림 걸기 / {artId} 기존 그림 옮기기
const history = [], future = [];
let dirty = false;
let lastFloorPoint = null;
let view = 'persp';
let mounts = new Map();         // key → 거는 면 (장면 좌표)

// ---------------- 유틸 ----------------
const V3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
const b2t = (v) => new THREE.Vector3(v[0], v[2], -v[1]);
const t2b = (p) => [p.x, -p.z, p.y];
const toThree = (x, y, z = 0) => new THREE.Vector3(x, z, -y);
const rad = THREE.MathUtils.degToRad;
const toM = (v) => v / U;
const fromM = (m) => m * U;
const MM = (v) => v / 1000 * U;
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const normDeg = (d) => { d %= 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return round(d, 2); };
const snapshot = () => JSON.stringify({ items: layout.items, storage: layout.storage, doll_spot: layout.doll_spot, arts: layout.arts },
  (k, v) => (k === 'pose' ? undefined : v));
const itemById = (id) => layout.items.find((e) => e.id === id);
const artById = (id) => layout.arts.find((a) => a.id === id);
const typeName = (t) => (types[t] ? types[t].name : t);
const artInfo = (file) => artworks.find((a) => a.file === file);
const artTitle = (a) => (artInfo(a.image) ? artInfo(a.image).name : a.image.split('/').pop());
const isSel = (kind, id) => sel && sel.kind === kind && sel.id === id;
const selItem = () => (sel && sel.kind === 'item' ? itemById(sel.id) : null);
const selArt = () => (sel && sel.kind === 'art' ? artById(sel.id) : null);

function toast(msg, ms = 2400) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}
const gridM = () => parseFloat($('gridStep').value);
const gridStep = () => fromM(gridM());
const rotStep = () => parseFloat($('rotStep').value);
function snapV(v) {
  if (!$('snap').checked) return round(v);
  const s = gridStep();
  return round(Math.round(v / s) * s);
}
function snapM(m) {
  if (!$('snap').checked) return round(m, 3);
  const s = gridM();
  return round(Math.round(m / s) * s, 3);
}

// ---------------- 실행취소 ----------------
function commit(before) {
  if (before === snapshot()) { refresh(); return; }
  history.push(before);
  if (history.length > 200) history.shift();
  future.length = 0;
  setDirty(true);
  refresh();
}
function mutate(fn) {
  const before = snapshot();
  fn();
  commit(before);
}
function restore(snap) {
  const s = JSON.parse(snap);
  Object.assign(layout, s);
  if (sel && ((sel.kind === 'item' && !itemById(sel.id)) || (sel.kind === 'art' && !artById(sel.id)))) sel = null;
  refresh();
}
function undo() {
  if (!history.length) return;
  future.push(snapshot());
  restore(history.pop());
  setDirty(true);
}
function redo() {
  if (!future.length) return;
  history.push(snapshot());
  restore(future.pop());
  setDirty(true);
}
function setDirty(v) {
  dirty = v;
  $('dirty').textContent = v ? '● 저장 안 됨' : '';
  $('undo').disabled = !history.length;
  $('redo').disabled = !future.length;
}

// ---------------- three.js 장면 ----------------
const canvas = $('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d1c22);
scene.add(new THREE.HemisphereLight(0xffffff, 0xcdbba8, 2.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(6, 20, 12);
scene.add(sun);

const persp = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
const top = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500);
const tv = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 500);
const orbit = new OrbitControls(persp, canvas);
const pan = new OrbitControls(top, canvas);
pan.enableRotate = false;
pan.screenSpacePanning = true;
pan.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
orbit.addEventListener('change', requestRender);
pan.addEventListener('change', requestRender);
// 콘솔/자동 테스트용
window.__editor = {
  persp, orbit, tv, THREE, b2t,
  get mounts() { return mounts; },
  get layout() { return layout; },
  get tvRect() { return tvRect; },
};

const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();
const modelCache = new Map();
const texCache = new Map();
const nodes = new Map();            // 가구 id → Group
const artNodes = new Map();         // 그림 id → {group, sig}
const surfaceGroup = new THREE.Group();
scene.add(surfaceGroup);
const surfMat = new THREE.MeshBasicMaterial({ color: 0x2f7fd8, transparent: true, opacity: 0.13, depthWrite: false, visible: false });
let shellNode = null;
let dollNode = null;
let ceilingParts = [];
const cacheBust = Date.now();

function loadModel(file) {
  if (!modelCache.has(file)) {
    modelCache.set(file, loader.loadAsync(`${MODEL_BASE}${file}?v=${cacheBust}`).then((g) => g.scene));
  }
  return modelCache.get(file);
}
function texture(file) {
  if (!texCache.has(file)) {
    const t = texLoader.load(`/${file}`, requestRender, undefined, () => toast(`그림을 불러오지 못했습니다: ${file}`));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texCache.set(file, t);
  }
  return texCache.get(file);
}

function activeCamera() { return view === 'top' ? top : view === 'tv' ? tv : persp; }

let renderQueued = false;
let tvRect = null;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}
function render() {
  renderQueued = false;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  for (const c of ceilingParts) c.visible = view === 'tv';
  for (const n of nodes.values()) {
    const fp = n.getObjectByName('footprint');
    if (fp) fp.visible = view !== 'tv' || isSel('item', n.userData.itemId);
  }
  if (view === 'tv') {
    let vw = w, vh = w * 9 / 16;
    if (vh > h) { vh = h; vw = h * 16 / 9; }
    const vx = (w - vw) / 2, vy = (h - vh) / 2;
    renderer.setScissorTest(true);
    renderer.setViewport(0, 0, w, h);
    renderer.setScissor(0, 0, w, h);
    renderer.setClearColor(0x000000);
    renderer.clear();
    renderer.setViewport(vx, vy, vw, vh);
    renderer.setScissor(vx, vy, vw, vh);
    renderer.render(scene, tv);
    renderer.setScissorTest(false);
    tvRect = { x: vx, y: vy, w: vw, h: vh };
  } else {
    renderer.setViewport(0, 0, w, h);
    const cam = activeCamera();
    if (cam.isPerspectiveCamera) { cam.aspect = w / h; cam.updateProjectionMatrix(); } else fitTop(w / h);
    renderer.render(scene, cam);
  }
}
function fitTop(aspect) {
  if (!room) return;
  const halfH = Math.max(room.depth / 2, room.width / 2 / aspect) * 1.08;
  top.left = -halfH * aspect; top.right = halfH * aspect;
  top.top = halfH; top.bottom = -halfH;
  top.updateProjectionMatrix();
}
function setView(v) {
  view = v;
  document.querySelectorAll('button.view').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  orbit.enabled = v === 'persp';
  pan.enabled = v === 'top';
  requestRender();
}
function setupCameras() {
  const cy = (room.front_y + room.back_y) / 2;
  persp.position.copy(toThree(4, room.front_y - 9, 15));
  orbit.target.copy(toThree(0, cy, 0));
  orbit.update();
  top.position.set(0, 60, -cy);
  top.up.set(0, 0, -1);
  top.lookAt(0, 0, -cy);
  pan.target.set(0, 0, -cy);
  pan.update();
  const t = room.tv_camera;
  tv.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(rad(t.hfov_deg) / 2) * 9 / 16));
  tv.aspect = 16 / 9;
  tv.position.copy(toThree(t.x, t.y, t.z));
  tv.lookAt(toThree(t.x, t.y + 10, t.z));
  tv.updateProjectionMatrix();
}

// ---------------- 거는 면 (벽 / 가벽 / 이젤) ----------------
const rotZ = (v, deg) => { const c = Math.cos(rad(deg)), s = Math.sin(rad(deg)); return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]]; };
const mkey = (host, id) => `${host || '#room'}:${id}`;
function makeMount(host, spec, e) {
  const o = V3.add(rotZ(spec.origin, e.rot), [e.x, e.y, 0]);
  const n = V3.norm(rotZ(spec.normal, e.rot));
  let up = V3.norm(rotZ(spec.up, e.rot));
  const right = V3.norm(V3.cross(up, n));
  up = V3.norm(V3.cross(n, right));
  return { key: mkey(host, spec.id), host, spec, o, n, up, right };
}
function computeMounts() {
  mounts = new Map();
  for (const m of room.mounts || []) {
    const mm = makeMount(null, m, { x: 0, y: 0, rot: 0 });
    mounts.set(mm.key, mm);
  }
  for (const e of layout.items) {
    for (const m of (types[e.type] && types[e.type].mounts) || []) {
      const mm = makeMount(e.id, m, e);
      mounts.set(mm.key, mm);
    }
  }
}
function mountLabel(m) {
  if (!m) return '걸 곳 없음';
  if (!m.host) return m.spec.name;
  const e = itemById(m.host);
  return `${e ? typeName(e.type) : m.host} · ${m.spec.name}`;
}
function basisMatrix(right, up, n, c) {
  const m4 = new THREE.Matrix4().makeBasis(b2t(right), b2t(up), b2t(n));
  m4.setPosition(b2t(c));
  return m4;
}
function rebuildSurfaces() {
  for (const c of [...surfaceGroup.children]) { c.geometry.dispose(); surfaceGroup.remove(c); }
  for (const m of mounts.values()) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(m.spec.width, m.spec.height), surfMat);
    const c = V3.add(V3.add(m.o, V3.mul(m.up, m.spec.height / 2)), V3.mul(m.n, MM(1)));
    plane.matrixAutoUpdate = false;
    plane.matrix.copy(basisMatrix(m.right, m.up, m.n, c));
    plane.userData.mountKey = m.key;
    surfaceGroup.add(plane);
  }
  surfaceGroup.updateMatrixWorld(true);
}
function showSurfaces(on) {
  surfMat.visible = on;
  requestRender();
}

// ---------------- 그림 ----------------
function artDims(a) {
  const w = fromM(a.width);
  return { w, h: w * a.aspect };
}
function artOuter(a) {
  const { w, h } = artDims(a);
  const fw = MM((FRAMES[a.frame] || FRAMES.canvas)[0]);
  return { w: w + 2 * fw, h: h + 2 * fw };
}
function artMount(a) { return a.mount ? mounts.get(mkey(a.mount.host, a.mount.id)) : null; }
function artUV(a, m) {
  const { h } = artDims(a);
  const u = fromM(a.u || 0);
  const v = m.spec.ledge ? h / 2 + MM((FRAMES[a.frame] || FRAMES.canvas)[0]) : fromM(a.v != null ? a.v : 1.5);
  return { u, v };
}
function resolveArt(a) {
  const m = artMount(a);
  if (!m) { a.pose = null; return null; }
  const { u, v } = artUV(a, m);
  const c = V3.add(m.o, V3.add(V3.mul(m.right, u), V3.mul(m.up, v)));
  a.pose = { c: c.map((x) => round(x, 5)), n: m.n.map((x) => round(x, 5)), up: m.up.map((x) => round(x, 5)) };
  return m;
}
function clampArt(a) {
  const m = artMount(a);
  if (!m) return;
  const o = artOuter(a);
  const W = m.spec.width, H = m.spec.height;
  const lim = Math.max(0, (W - o.w) / 2);
  a.u = round(toM(clamp(fromM(a.u || 0), -lim, lim)), 3);
  if (m.spec.ledge) {
    delete a.v;
  } else {
    const v = fromM(a.v != null ? a.v : 1.5);
    const lo = Math.min(o.h / 2, H / 2), hi = Math.max(H - o.h / 2, H / 2);
    a.v = round(toM(clamp(v, lo, hi)), 3);
  }
  a.width = round(clamp(a.width, 0.05, 20), 3);
}
function buildArtGroup(a) {
  const g = new THREE.Group();
  g.userData.artId = a.id;
  const { w, h } = artDims(a);
  const D = MM(ART_DEPTH_MM);
  const [fwmm, fdmm, fcol] = FRAMES[a.frame] || FRAMES.canvas;
  const fw = MM(fwmm), fd = MM(fdmm);
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, D),
    new THREE.MeshStandardMaterial({ color: fcol === null ? 0xf4f1ea : 0x3c3a38, roughness: 0.8 }));
  body.position.z = D / 2;
  g.add(body);
  if (fcol !== null) {
    const fm = new THREE.MeshStandardMaterial({ color: fcol, roughness: 0.45 });
    for (const [cx, cy, sx, sy] of [[0, h / 2 + fw / 2, w + 2 * fw, fw], [0, -h / 2 - fw / 2, w + 2 * fw, fw],
      [-w / 2 - fw / 2, 0, fw, h], [w / 2 + fw / 2, 0, fw, h]]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, fd), fm);
      bar.position.set(cx, cy, fd / 2);
      g.add(bar);
    }
  }
  const img = new THREE.Mesh(new THREE.PlaneGeometry(w, h), artInfo(a.image)
    ? new THREE.MeshStandardMaterial({ map: texture(a.image), roughness: 0.6 })
    : new THREE.MeshStandardMaterial({ color: 0xc8c4be, roughness: 0.9 }));
  img.position.z = D + MM(1);
  g.add(img);
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) =>
      new THREE.Vector3(x * (w / 2 + fw + MM(15)), y * (h / 2 + fw + MM(15)), D + MM(3)))),
    new THREE.LineBasicMaterial({ color: 0x2f7fd8, depthTest: false }));
  outline.name = 'selOutline';
  outline.renderOrder = 11;
  g.add(outline);
  g.matrixAutoUpdate = false;
  return g;
}
function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material && o.material.dispose) o.material.dispose();
  });
}
function syncArts(bad) {
  const want = new Set(layout.arts.map((a) => a.id));
  for (const [id, rec] of artNodes) {
    if (!want.has(id)) { scene.remove(rec.group); disposeGroup(rec.group); artNodes.delete(id); }
  }
  for (const a of layout.arts) {
    const m = resolveArt(a);
    const sig = `${a.image}|${a.width}|${a.aspect}|${a.frame}|${!!artInfo(a.image)}`;
    let rec = artNodes.get(a.id);
    if (rec && rec.sig !== sig) { scene.remove(rec.group); disposeGroup(rec.group); rec = null; }
    if (!rec) {
      rec = { group: buildArtGroup(a), sig };
      scene.add(rec.group);
      artNodes.set(a.id, rec);
    }
    const g = rec.group;
    g.visible = !!m;
    if (m) {
      g.matrix.copy(basisMatrix(m.right, m.up, m.n, a.pose.c));
      g.matrixWorldNeedsUpdate = true;
      g.updateMatrixWorld(true);
    }
    const ol = g.getObjectByName('selOutline');
    ol.visible = isSel('art', a.id) || bad.has(a.id);
    ol.material.color.set(isSel('art', a.id) ? 0x2f7fd8 : 0xe0413f);
  }
}
function hiddenPrefixes() {
  const out = new Map();
  for (const a of layout.arts) {
    const m = artMount(a);
    if (m && m.host && m.spec.hides && m.spec.hides.length) {
      if (!out.has(m.host)) out.set(m.host, []);
      out.get(m.host).push(...m.spec.hides);
    }
  }
  return out;
}
function uniqueArtId() {
  const used = new Set([...layout.arts.map((a) => a.id),
    ...layout.storage.flatMap((e) => (e.arts || []).map((a) => a.id))]);
  let n = 1;
  while (used.has(`art_${n}`)) n++;
  return `art_${n}`;
}

// ---------------- 가구 표시 ----------------
function footprintLine(t) {
  const b = t.bbox;
  const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(([x, y]) => toThree(x, y, 0.03));
  const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xbbbbbb, depthTest: false }));
  line.renderOrder = 10;
  line.name = 'footprint';
  if (t.back) {
    const [bx, by] = t.back;
    const fx = -bx, fy = -by;
    const ex = fx > 0 ? b.x1 : fx < 0 ? b.x0 : (b.x0 + b.x1) / 2;
    const ey = fy > 0 ? b.y1 : fy < 0 ? b.y0 : (b.y0 + b.y1) / 2;
    const s = 0.18;
    const tri = [[ex + fx * s, ey + fy * s], [ex - fy * s, ey + fx * s], [ex + fy * s, ey - fx * s]].map(([x, y]) => toThree(x, y, 0.03));
    const arrow = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(tri), line.material);
    arrow.renderOrder = 10;
    line.add(arrow);
  }
  return line;
}
function applyHides(n, prefixes) {
  const model = n.getObjectByName('model');
  if (!model) return;
  model.traverse((o) => {
    if (o === model) return;
    o.visible = !prefixes.some((p) => o.name.startsWith(p));
  });
}
function syncNodes() {
  const want = new Map(layout.items.map((e) => [e.id, e]));
  for (const [id, n] of nodes) {
    const e = want.get(id);
    if (!e || e.type !== n.userData.type) { scene.remove(n); nodes.delete(id); }
  }
  const hides = hiddenPrefixes();
  for (const e of layout.items) {
    let n = nodes.get(e.id);
    const t = types[e.type];
    if (!t) continue;
    if (!n) {
      n = new THREE.Group();
      n.userData = { itemId: e.id, type: e.type };
      n.add(footprintLine(t));
      scene.add(n);
      nodes.set(e.id, n);
      loadModel(t.file).then((src) => {
        if (nodes.get(e.id) !== n) return;
        const c = src.clone(true);
        c.name = 'model';
        n.add(c);
        applyHides(n, hiddenPrefixes().get(e.id) || []);
        requestRender();
      }).catch(() => toast(`모델을 불러오지 못했습니다: ${t.file}`));
    }
    n.position.copy(toThree(e.x, e.y));
    n.rotation.set(0, rad(e.rot), 0);
    n.updateMatrixWorld(true);
    applyHides(n, hides.get(e.id) || []);
  }
  if (dollNode) dollNode.position.copy(toThree(layout.doll_spot.x, layout.doll_spot.y));
}

// ---------------- 충돌 검사 ----------------
function corners(e, shrink = EPS) {
  const b = types[e.type].bbox;
  const c = Math.cos(rad(e.rot)), s = Math.sin(rad(e.rot));
  return [[b.x0 + shrink, b.y0 + shrink], [b.x1 - shrink, b.y0 + shrink], [b.x1 - shrink, b.y1 - shrink], [b.x0 + shrink, b.y1 - shrink]]
    .map(([x, y]) => [e.x + c * x - s * y, e.y + s * x + c * y]);
}
const rectPoly = (r) => [[r.x0 + EPS, r.y0 + EPS], [r.x1 - EPS, r.y0 + EPS], [r.x1 - EPS, r.y1 - EPS], [r.x0 + EPS, r.y1 - EPS]];
function overlap(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      const nx = y1 - y2, ny = x2 - x1;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const [x, y] of a) { const d = x * nx + y * ny; amin = Math.min(amin, d); amax = Math.max(amax, d); }
      for (const [x, y] of b) { const d = x * nx + y * ny; bmin = Math.min(bmin, d); bmax = Math.max(bmax, d); }
      if (amax <= bmin || bmax <= amin) return false;
    }
  }
  return true;
}
const kind = (type) => (type === 'table' ? 'table' : type.includes('chair') ? 'chair' : type);
function allowed(t1, t2) {
  if (FLOOR_LAYER.has(t1) || FLOOR_LAYER.has(t2)) return true;
  const k1 = kind(t1), k2 = kind(t2);
  return TUCK_PAIRS.some(([a, b]) => (a === k1 && b === k2) || (a === k2 && b === k1));
}
// ---------------- 벽/기둥 막기 ----------------
// 가구 바닥 윤곽이 벽(앞 입구 포함) 밖으로 나가거나 기둥을 뚫지 못하게 위치를 제한한다
let blockedId = null;            // 방금 막힌 가구 (윤곽을 주황색으로 표시)
function footprintExtents(type, rotDeg) {
  const b = types[type].bbox;
  const c = Math.cos(rad(rotDeg)), s = Math.sin(rad(rotDeg));
  const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(([x, y]) => [c * x - s * y, s * x + c * y]);
  return {
    x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])),
    y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])),
  };
}
function clampToRoom(e, x, y, rot = e.rot) {
  if (!types[e.type]) return [x, y];
  const ex = footprintExtents(e.type, rot);
  const w = room.walls;
  const xlo = w.left - ex.x0, xhi = w.right - ex.x1;
  const ylo = room.front_y - ex.y0, yhi = w.back - ex.y1;
  const cx = xlo > xhi ? (xlo + xhi) / 2 : clamp(x, xlo, xhi);
  const cy = ylo > yhi ? (ylo + yhi) / 2 : clamp(y, ylo, yhi);
  return [round(cx), round(cy)];
}
function hitsObstacle(e, x, y, rot = e.rot) {
  if (!types[e.type] || FLOOR_LAYER.has(e.type) || !room.obstacles.length) return false;
  const p = corners({ ...e, x, y, rot });
  return room.obstacles.some((ob) => overlap(p, rectPoly(ob)));
}
// (e.x, e.y) 에서 (tx, ty) 로 옮길 때 실제로 갈 수 있는 위치. 막히면 닿는 곳에서 멈추고, 벽/기둥을 따라 미끄러짐
function constrainMove(e, tx, ty) {
  const [cx, cy] = clampToRoom(e, tx, ty);
  let blocked = cx !== round(tx) || cy !== round(ty);
  if (!hitsObstacle(e, cx, cy)) return { x: cx, y: cy, blocked };
  const [sx, sy] = clampToRoom(e, e.x, e.y);
  if (hitsObstacle(e, sx, sy)) return { x: cx, y: cy, blocked };   // 이미 끼어 있으면 빠져나올 수 있게 허용
  let best = { x: sx, y: sy }, bestD = -1;
  for (const [gx, gy] of [[cx, cy], [cx, sy], [sx, cy]]) {
    const at = (t) => [sx + (gx - sx) * t, sy + (gy - sy) * t];
    let lo = 0, hi = 1;
    if (!hitsObstacle(e, ...at(1))) lo = 1;
    else {
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        if (hitsObstacle(e, ...at(mid))) hi = mid; else lo = mid;
      }
    }
    const [px, py] = at(lo);
    const d = Math.hypot(px - sx, py - sy);
    if (d > bestD + 1e-6) { bestD = d; best = { x: round(px), y: round(py) }; }
  }
  return { x: best.x, y: best.y, blocked: true };
}
// 가구 e 를 (tx, ty) 로 옮김 (방/기둥 제한 적용). 막혔으면 true
function moveItemTo(e, tx, ty) {
  const r = constrainMove(e, tx, ty);
  e.x = r.x;
  e.y = r.y;
  return r.blocked;
}
// 회전/교체/추가 뒤 벽 밖으로 삐져나온 부분을 안으로 밀어 넣음
function keepInside(e) {
  const [x, y] = clampToRoom(e, e.x, e.y);
  e.x = x;
  e.y = y;
}
function clampDoll(p) {
  const m = 0.3;
  p.x = round(clamp(p.x, room.walls.left + m, room.walls.right - m));
  p.y = round(clamp(p.y, room.front_y + m, room.walls.back - m));
}
function flashBlocked(id) {
  blockedId = id;
  clearTimeout(flashBlocked.t);
  flashBlocked.t = setTimeout(() => { blockedId = null; refresh(); }, 500);
}

function checkCollisions() {
  const warns = [];
  const bad = new Set();
  const polys = layout.items.filter((e) => types[e.type]).map((e) => ({ e, p: corners(e) }));
  const w = room.walls;
  for (const { e, p } of polys) {
    if (p.some(([x, y]) => x < w.left - EPS || x > w.right + EPS || y < room.front_y - EPS || y > w.back + EPS)) {
      warns.push({ kind: 'item', id: e.id, text: `${typeName(e.type)} (${e.id}): 방 밖으로 나감` });
      bad.add(e.id);
    }
    if (FLOOR_LAYER.has(e.type)) continue;
    for (const ob of room.obstacles) {
      if (overlap(p, rectPoly(ob))) {
        warns.push({ kind: 'item', id: e.id, text: `${typeName(e.type)} (${e.id}) ↔ ${ob.name} 겹침` });
        bad.add(e.id);
      }
    }
  }
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      const a = polys[i], b = polys[j];
      if (allowed(a.e.type, b.e.type)) continue;
      if (overlap(a.p, b.p)) {
        warns.push({ kind: 'item', id: a.e.id, text: `${a.e.id} ↔ ${b.e.id} 겹침` });
        bad.add(a.e.id);
        bad.add(b.e.id);
      }
    }
  }
  // 그림: 걸 곳 없음 / 면보다 큼 / 같은 면에서 겹침
  const byMount = new Map();
  for (const a of layout.arts) {
    const m = artMount(a);
    if (!m) {
      warns.push({ kind: 'art', id: a.id, text: `그림 ${artTitle(a)}: 걸려 있던 곳이 없음` });
      bad.add(a.id);
      continue;
    }
    if (!artInfo(a.image)) {
      warns.push({ kind: 'art', id: a.id, text: `그림 ${artTitle(a)}: 파일이 없음 (같은 파일을 다시 올리면 복구)` });
      bad.add(a.id);
    }
    const o = artOuter(a);
    if (!m.spec.ledge && (o.w > m.spec.width + EPS || o.h > m.spec.height + EPS)) {
      warns.push({ kind: 'art', id: a.id, text: `그림 ${artTitle(a)}: ${mountLabel(m)}보다 큼` });
      bad.add(a.id);
    }
    const { u, v } = artUV(a, m);
    if (!byMount.has(m.key)) byMount.set(m.key, []);
    byMount.get(m.key).push({ a, u, v, o });
  }
  for (const list of byMount.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p = list[i], q = list[j];
        if (Math.abs(p.u - q.u) < (p.o.w + q.o.w) / 2 - EPS && Math.abs(p.v - q.v) < (p.o.h + q.o.h) / 2 - EPS) {
          warns.push({ kind: 'art', id: p.a.id, text: `그림 ${artTitle(p.a)} ↔ ${artTitle(q.a)} 겹침` });
          bad.add(p.a.id);
          bad.add(q.a.id);
        }
      }
    }
  }
  return { warns, bad };
}

// ---------------- 화면 갱신 ----------------
function refresh() {
  computeMounts();
  syncNodes();
  rebuildSurfaces();
  const { warns, bad } = checkCollisions();
  syncArts(bad);
  for (const [id, n] of nodes) {
    const fp = n.getObjectByName('footprint');
    if (fp) fp.material.color.set(id === blockedId ? 0xf08a24 : isSel('item', id) ? 0x2f7fd8 : bad.has(id) ? 0xe0413f : 0xbbbbbb);
  }
  renderWarnings(warns);
  renderItemList(bad);
  renderStorage();
  renderLibrary();
  renderSelection();
  $('undo').disabled = !history.length;
  $('redo').disabled = !future.length;
  requestRender();
}

function renderWarnings(warns) {
  const ul = $('warnings');
  ul.innerHTML = '';
  if (!warns.length) {
    const li = document.createElement('li');
    li.className = 'ok';
    li.textContent = '겹치는 가구·그림이 없습니다';
    ul.append(li);
    return;
  }
  for (const w of warns) {
    const li = document.createElement('li');
    li.textContent = '⚠ ' + w.text;
    li.onclick = () => select(w.kind, w.id);
    ul.append(li);
  }
}
// ---------------- 썸네일 ----------------
// 가구 모델을 작은 화면에 한 번 렌더해 이미지로 보관 (종류당 한 번)
const THUMB = 160;
const thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
thumbRenderer.setPixelRatio(1);
thumbRenderer.setSize(THUMB, THUMB);
thumbRenderer.toneMapping = THREE.NeutralToneMapping;
const thumbScene = new THREE.Scene();
thumbScene.add(new THREE.HemisphereLight(0xffffff, 0xcdbba8, 2.6));
const thumbSun = new THREE.DirectionalLight(0xffffff, 1.8);
thumbSun.position.set(4, 10, 8);
thumbScene.add(thumbSun);
const thumbCam = new THREE.PerspectiveCamera(28, 1, 0.01, 200);
const thumbCache = new Map();
function renderThumb(obj, back) {
  thumbScene.add(obj);
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  // 가구 앞(= back 의 반대쪽)에서 비스듬히 위로
  const f = back ? new THREE.Vector3(-back[0], 0, back[1]) : new THREE.Vector3(0, 0, 1);
  const side = new THREE.Vector3(f.z, 0, -f.x);
  const dir = f.clone().add(side.multiplyScalar(0.55)).add(new THREE.Vector3(0, 0.62, 0)).normalize();
  const dist = radius / Math.sin(rad(thumbCam.fov / 2)) * 1.02;
  thumbCam.position.copy(center).addScaledVector(dir, dist);
  thumbCam.lookAt(center);
  thumbRenderer.render(thumbScene, thumbCam);
  const url = thumbRenderer.domElement.toDataURL('image/png');
  thumbScene.remove(obj);
  return url;
}
function typeThumb(typeId) {
  if (!thumbCache.has(typeId)) {
    const t = types[typeId];
    thumbCache.set(typeId, loadModel(t.file).then((src) => renderThumb(src.clone(true), t.back)).catch(() => ''));
  }
  return thumbCache.get(typeId);
}
let dollPromise = null;
function loadDoll() {
  if (!dollPromise) {
    dollPromise = loader.loadAsync(`${MODEL_BASE}doll.glb?v=${cacheBust}`).then(async (g) => {
      try { applyLook(g.scene, (await api.config()).ribbon.look); } catch { applyLook(g.scene, undefined); }
      return g;
    });
  }
  return dollPromise;
}
function dollThumb() {
  if (!thumbCache.has('__doll')) {
    thumbCache.set('__doll', loadDoll()
      .then((g) => renderThumb(g.scene.clone(true), null)).catch(() => ''));
  }
  return thumbCache.get('__doll');
}
function thumbImg(promiseOrUrl, alt) {
  const img = document.createElement('img');
  img.className = 'thumb';
  img.alt = alt || '';
  if (typeof promiseOrUrl === 'string') img.src = promiseOrUrl;
  else promiseOrUrl.then((u) => { if (u) img.src = u; });
  return img;
}
const shortName = (name) => name.replace(/\s*\(.*\)\s*$/, '');
const nameDetail = (name) => { const m = name.match(/\((.*)\)\s*$/); return m ? m[1] : ''; };

// ---------------- 배치 목록 (썸네일 + 5개씩) ----------------
const PAGE_SIZE = 5;
let listPage = 0;
let lastSelKey = null;
function listEntries(bad) {
  const out = [{ key: 'doll:doll', thumb: dollThumb(), name: '리본이 자리', sub: '부르면 걸어오는 곳',
    sel: isSel('doll', 'doll'), bad: false, onclick: () => select('doll', 'doll') }];
  for (const e of layout.items) {
    out.push({ key: `item:${e.id}`, thumb: typeThumb(e.type), name: shortName(typeName(e.type)), sub: e.id,
      sel: isSel('item', e.id), bad: bad.has(e.id), onclick: () => select('item', e.id) });
  }
  for (const a of layout.arts) {
    out.push({ key: `art:${a.id}`, thumb: '/' + a.image, name: artTitle(a), sub: `그림 · ${mountLabel(artMount(a))}`,
      sel: isSel('art', a.id), bad: bad.has(a.id), onclick: () => select('art', a.id) });
  }
  return out;
}
function renderItemList(bad) {
  const ul = $('itemList');
  ul.innerHTML = '';
  const entries = listEntries(bad);
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const selKey = sel ? `${sel.kind}:${sel.id}` : null;
  if (selKey && selKey !== lastSelKey) {          // 선택이 바뀌면 그 항목이 있는 쪽으로
    const i = entries.findIndex((x) => x.key === selKey);
    if (i >= 0) listPage = Math.floor(i / PAGE_SIZE);
  }
  lastSelKey = selKey;
  listPage = clamp(listPage, 0, pages - 1);
  for (const x of entries.slice(listPage * PAGE_SIZE, (listPage + 1) * PAGE_SIZE)) {
    const li = document.createElement('li');
    li.className = 'thumbRow';
    li.classList.toggle('sel', x.sel);
    li.append(thumbImg(x.thumb, x.name));
    const text = document.createElement('div');
    text.className = 'rowText';
    const n = document.createElement('div');
    n.className = 'rowName';
    n.textContent = x.name;
    const sub = document.createElement('div');
    sub.className = 'rowSub';
    sub.textContent = x.sub;
    text.append(n, sub);
    li.append(text);
    if (x.bad) {
      const w = document.createElement('span');
      w.className = 'bad';
      w.textContent = '⚠';
      w.title = '경고가 있습니다';
      li.append(w);
    }
    li.title = x.name;
    li.onclick = x.onclick;
    ul.append(li);
  }
  $('listCount').textContent = `(${entries.length})`;
  $('pgInfo').textContent = `${listPage + 1} / ${pages}`;
  $('pgPrev').disabled = $('pgFirst').disabled = listPage <= 0;
  $('pgNext').disabled = $('pgLast').disabled = listPage >= pages - 1;
}
function goPage(pg) {
  listPage = pg;
  renderItemList(checkCollisions().bad);
}
$('pgPrev').onclick = () => goPage(listPage - 1);
$('pgNext').onclick = () => goPage(listPage + 1);
$('pgFirst').onclick = () => goPage(0);
$('pgLast').onclick = () => goPage(1e9);
function renderStorage() {
  const ul = $('storage');
  ul.innerHTML = '';
  $('storageBox').hidden = !layout.storage.length;
  $('storageCount').textContent = `(${layout.storage.length})`;
  layout.storage.forEach((e, i) => {
    const li = document.createElement('li');
    li.className = 'thumbRow';
    li.title = typeName(e.type);
    li.append(thumbImg(typeThumb(e.type), typeName(e.type)));
    const name = document.createElement('div');
    name.className = 'rowText';
    const nm = document.createElement('div');
    nm.className = 'rowName';
    nm.textContent = shortName(typeName(e.type));
    const sub = document.createElement('div');
    sub.className = 'rowSub';
    sub.textContent = `${e.id}${e.arts && e.arts.length ? ` · 그림 ${e.arts.length}점` : ''}`;
    name.append(nm, sub);
    const put = document.createElement('button');
    put.textContent = '다시 배치';
    put.onclick = (ev) => { ev.stopPropagation(); placeFromStorage(i); };
    const del = document.createElement('button');
    del.textContent = '삭제';
    del.onclick = (ev) => { ev.stopPropagation(); mutate(() => layout.storage.splice(i, 1)); };
    const btns = document.createElement('span');
    btns.append(put, del);
    li.append(name, btns);
    ul.append(li);
  });
}
// ---------------- 왼쪽 패널 큰 탭 ----------------
function setMainTab(name) {
  document.querySelectorAll('.mainTab').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === name);
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  });
  document.querySelectorAll('.tabPanel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  try { localStorage.setItem('layoutEditor.mainTab', name); } catch { /* 저장소 없음 */ }
}
document.querySelectorAll('.mainTab').forEach((b) => { b.onclick = () => setMainTab(b.dataset.tab); });
{
  let t = 'catalog';
  try { t = localStorage.getItem('layoutEditor.mainTab') || t; } catch { /* 저장소 없음 */ }
  setMainTab(['catalog', 'list', 'art'].includes(t) ? t : 'catalog');
}

// ---------------- 가구 카탈로그 (분류 탭 + 썸네일 그리드) ----------------
let activeCat = null;
function catOrder() {
  const cats = [...new Set(Object.values(types).map((t) => t.category))];
  const first = roomId === 'gallery' ? ['전시', '미술'] : ['수납장', '주방', '책상·의자', '놀이', '미술'];
  return cats.sort((x, y) => {
    const ix = first.indexOf(x), iy = first.indexOf(y);
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
  });
}
function renderCatalog() {
  const cats = catOrder();
  let saved = null;
  try { saved = localStorage.getItem(`layoutEditor.cat.${roomId}`); } catch { /* 저장소 없음 */ }
  if (!cats.includes(activeCat)) activeCat = cats.includes(saved) ? saved : cats[0];
  const tabs = $('catTabs');
  tabs.innerHTML = '';
  for (const c of cats) {
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(c === activeCat));
    btn.classList.toggle('on', c === activeCat);
    btn.textContent = c;
    btn.onclick = () => {
      activeCat = c;
      try { localStorage.setItem(`layoutEditor.cat.${roomId}`, c); } catch { /* 저장소 없음 */ }
      renderCatalog();
    };
    tabs.append(btn);
  }
  const box = $('catalog');
  box.innerHTML = '';
  for (const t of Object.values(types).filter((x) => x.category === activeCat)) {
    const card = document.createElement('button');
    card.className = 'card';
    card.title = `${t.name}\n누르면 방에 배치됩니다`;
    card.append(thumbImg(typeThumb(t.id), t.name));
    const n = document.createElement('span');
    n.className = 'cardName';
    n.textContent = shortName(t.name);
    card.append(n);
    const detail = nameDetail(t.name);
    if (detail) {
      const d = document.createElement('span');
      d.className = 'cardSub';
      d.textContent = detail;
      card.append(d);
    }
    card.onclick = () => addItem(t.id);
    box.append(card);
  }
  const sel2 = $('replaceType');
  sel2.innerHTML = '';
  for (const t of Object.values(types)) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = `[${t.category}] ${t.name}`;
    sel2.append(o);
  }
}
function renderLibrary() {
  $('artCount').textContent = artworks.length ? `(${artworks.length})` : '';
  const box = $('artLibrary');
  box.innerHTML = '';
  if (!artworks.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '아직 올린 그림이 없습니다';
    box.append(p);
    return;
  }
  for (const aw of artworks) {
    const d = document.createElement('div');
    d.className = 'art';
    d.title = `${aw.name} (${aw.width}×${aw.height})\n누른 뒤 벽·가벽·이젤을 클릭하면 걸립니다`;
    d.classList.toggle('on', !!(placing && placing.file === aw.file));
    const img = document.createElement('img');
    img.src = '/' + aw.file;
    img.alt = aw.name;
    img.loading = 'lazy';
    d.append(img);
    const used = layout.arts.filter((a) => a.image === aw.file).length;
    if (used) {
      const u = document.createElement('span');
      u.className = 'used';
      u.textContent = `${used}점`;
      d.append(u);
    }
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = '그림 파일 지우기';
    del.onclick = (ev) => { ev.stopPropagation(); deleteArtwork(aw); };
    d.append(del);
    d.onclick = () => (placing && placing.file === aw.file ? stopPlacing() : startPlacing({ file: aw.file }));
    box.append(d);
  }
}
function renderSelection() {
  const it = selItem();
  const art = selArt();
  const isDoll = sel && sel.kind === 'doll';
  $('sel').hidden = !(it || isDoll);
  $('artSel').hidden = !art;
  $('noSel').hidden = !!(it || isDoll || art);
  const active = document.activeElement;
  if (art) {
    const m = artMount(art);
    $('artThumb').src = '/' + art.image;
    $('artName').textContent = artTitle(art);
    $('artWhere').textContent = `걸린 곳: ${mountLabel(m)}`;
    const setv = (id, v) => { if (active !== $(id)) $(id).value = v; };
    setv('artW', round(art.width, 3));
    setv('artH', round(art.width * art.aspect, 3));
    setv('artScale', art.width);
    $('artScale').max = Math.max(4, art.width);
    setv('artU', round(art.u || 0, 3));
    $('artVRow').hidden = !m || m.spec.ledge;
    setv('artV', round(art.v != null ? art.v : 1.5, 3));
    $('artFrame').value = art.frame || 'canvas';
    return;
  }
  if (!(it || isDoll)) return;
  const pos = isDoll ? layout.doll_spot : it;
  $('selName').textContent = isDoll ? '리본이 자리' : shortName(typeName(it.type));
  const thumbKey = isDoll ? '__doll' : it.type;
  if ($('selThumb').dataset.key !== thumbKey) {
    $('selThumb').dataset.key = thumbKey;
    $('selThumb').removeAttribute('src');
    (isDoll ? dollThumb() : typeThumb(it.type)).then((u) => {
      if (u && $('selThumb').dataset.key === thumbKey) $('selThumb').src = u;
    });
  }
  const mountsOf = it && types[it.type] && types[it.type].mounts && types[it.type].mounts.length;
  $('selId').textContent = isDoll ? '평소엔 방을 돌아다니다가, 부르면 이 자리로 걸어옵니다'
    : `${nameDetail(typeName(it.type)) ? nameDetail(typeName(it.type)) + ' · ' : ''}${it.id}${mountsOf ? ' · 그림을 걸 수 있음' : ''}`;
  for (const id of ['rotField', 'rotButtons', 'itemButtons', 'replaceRow']) $(id).hidden = isDoll;
  $('fx').closest('.fields').classList.toggle('three', !isDoll);
  $('fx').closest('.fields').classList.toggle('two', isDoll);
  if (active !== $('fx')) $('fx').value = round(toM(pos.x), 3);
  if (active !== $('fy')) $('fy').value = round(toM(pos.y), 3);
  if (it) {
    if (active !== $('frot')) $('frot').value = it.rot;
    $('replaceType').value = it.type;
  }
}

// ---------------- 가구 편집 ----------------
function select(kindName, id) {
  sel = kindName ? { kind: kindName, id } : null;
  refresh();
}
function uniqueId(base) {
  const used = new Set([...layout.items, ...layout.storage].map((e) => e.id));
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}
function addItem(type) {
  const p = lastFloorPoint || { x: 0, y: (room.front_y + room.back_y) / 2 };
  const e = { id: uniqueId(type), type, x: snapV(p.x), y: snapV(p.y), rot: 0 };
  keepInside(e);
  mutate(() => layout.items.push(e));
  select('item', e.id);
  toast(`${typeName(type)} 배치됨`);
}
function removeSelected() {
  const art = selArt();
  if (art) { removeArt(art.id); return; }
  const it = selItem();
  if (!it) return;
  let n = 0;
  mutate(() => {
    const i = layout.items.findIndex((e) => e.id === it.id);
    const [e] = layout.items.splice(i, 1);
    const attached = layout.arts.filter((a) => a.mount && a.mount.host === e.id);
    n = attached.length;
    if (n) {
      e.arts = attached.map(({ pose, ...rest }) => rest);
      layout.arts = layout.arts.filter((a) => !attached.includes(a));
    }
    layout.storage.push(e);
    sel = null;
  });
  toast(n ? `배치 해제했습니다 (걸린 그림 ${n}점도 함께) · 배치 목록 탭 아래에서 다시 놓을 수 있습니다`
    : '배치 해제했습니다 · 배치 목록 탭 아래에서 다시 놓을 수 있습니다', 3500);
}
function placeFromStorage(i) {
  const e = layout.storage[i];
  mutate(() => {
    layout.storage.splice(i, 1);
    const arts = e.arts || [];
    delete e.arts;
    if (itemById(e.id)) e.id = uniqueId(e.type);
    keepInside(e);
    layout.items.push(e);
    for (const a of arts) {
      a.mount = { ...a.mount, host: e.id };
      if (artById(a.id)) a.id = uniqueArtId();
      layout.arts.push(a);
    }
  });
  select('item', e.id);
}
function duplicateSelected() {
  const art = selArt();
  if (art) {
    const c = { ...art, id: uniqueArtId(), u: round((art.u || 0) + art.width + 0.1, 3) };
    delete c.pose;
    mutate(() => { layout.arts.push(c); clampArt(c); });
    select('art', c.id);
    return;
  }
  const e = selItem();
  if (!e) return;
  const c = { ...e, id: uniqueId(e.type) };
  moveItemTo(c, snapV(e.x + fromM(0.5)), snapV(e.y - fromM(0.5)));
  mutate(() => layout.items.push(c));
  select('item', c.id);
}
function replaceSelected(type) {
  const e = selItem();
  if (!e || e.type === type) return;
  const keep = new Set(((types[type] && types[type].mounts) || []).map((m) => m.id));
  let dropped = 0;
  mutate(() => {
    e.type = type;
    keepInside(e);
    const before = layout.arts.length;
    layout.arts = layout.arts.filter((a) => !(a.mount && a.mount.host === e.id && !keep.has(a.mount.id)));
    dropped = before - layout.arts.length;
  });
  toast(`${typeName(type)}(으)로 교체${dropped ? ` · 걸 곳이 없어진 그림 ${dropped}점을 내렸습니다` : ''}`);
}
function rotateSelected(delta) {
  const e = selItem();
  if (!e) return;
  const rot = normDeg(e.rot + delta);
  const [x, y] = clampToRoom(e, e.x, e.y, rot);
  if (hitsObstacle(e, x, y, rot) && !hitsObstacle(e, e.x, e.y)) {
    flashBlocked(e.id);
    toast('기둥에 막혀 돌릴 수 없습니다. 조금 떨어뜨린 뒤 돌리세요');
    refresh();
    return;
  }
  const pushed = x !== e.x || y !== e.y;
  mutate(() => { e.rot = rot; e.x = x; e.y = y; });
  if (pushed) { flashBlocked(e.id); toast('벽에 닿아 안쪽으로 밀었습니다'); }
}
function moveSelected(dx, dy) {
  const art = selArt();
  if (art) {
    const m = artMount(art);
    mutate(() => {
      art.u = round((art.u || 0) + toM(dx), 3);
      if (m && !m.spec.ledge) art.v = round((art.v != null ? art.v : 1.5) + toM(dy), 3);
      clampArt(art);
    });
    return;
  }
  const p = sel && sel.kind === 'doll' ? layout.doll_spot : selItem();
  if (!p) return;
  let blocked = false;
  mutate(() => {
    if (p === layout.doll_spot) {
      p.x = snapV(p.x + dx);
      p.y = snapV(p.y + dy);
      clampDoll(p);
    } else {
      blocked = moveItemTo(p, snapV(p.x + dx), snapV(p.y + dy));
    }
  });
  if (blocked) { flashBlocked(p.id); refresh(); }
}
function toWall() {
  const e = selItem();
  if (!e) return;
  const t = types[e.type];
  const w = room.walls;
  const walls = [
    { out: [-1, 0], d: -w.left, dist: Math.abs(e.x - w.left), name: '왼쪽 벽' },
    { out: [1, 0], d: w.right, dist: Math.abs(w.right - e.x), name: '오른쪽 벽' },
    { out: [0, 1], d: w.back, dist: Math.abs(w.back - e.y), name: '정면 벽' },
  ].sort((a, b) => a.dist - b.dist);
  const wall = walls[0];
  mutate(() => {
    if (t.back) {
      const want = Math.atan2(wall.out[1], wall.out[0]);
      const have = Math.atan2(t.back[1], t.back[0]);
      e.rot = normDeg(THREE.MathUtils.radToDeg(want - have));
    }
    keepInside(e);
    const pts = corners(e, 0);
    const ext = Math.max(...pts.map(([x, y]) => (x - e.x) * wall.out[0] + (y - e.y) * wall.out[1]));
    const cur = e.x * wall.out[0] + e.y * wall.out[1];
    const move = wall.d - ext - cur;
    moveItemTo(e, e.x + wall.out[0] * move, e.y + wall.out[1] * move);
  });
  toast(`${wall.name}에 붙였습니다`);
}

// ---------------- 그림 편집 ----------------
function startPlacing(p) {
  placing = p;
  $('viewport').classList.add('placing');
  $('placing').hidden = false;
  $('placing').textContent = p.artId
    ? '그림을 옮길 벽·가벽·이젤을 클릭하세요 (Esc 취소)'
    : '그림을 걸 벽·가벽·이젤을 클릭하세요 · Shift+클릭: 계속 걸기 · Esc 취소';
  showSurfaces(true);
  renderLibrary();
}
function stopPlacing() {
  placing = null;
  $('viewport').classList.remove('placing');
  $('placing').hidden = true;
  showSurfaces(false);
  renderLibrary();
}
function hitUV(m, p) {
  const d = V3.sub(p, m.o);
  return { u: V3.dot(d, m.right), v: V3.dot(d, m.up) };
}
function placeArtAt(hit, keep) {
  const m = mounts.get(hit.key);
  const { u, v } = hitUV(m, hit.point);
  if (placing.artId) {
    const a = artById(placing.artId);
    mutate(() => {
      a.mount = { host: m.host, id: m.spec.id };
      a.u = snapM(toM(u));
      if (!m.spec.ledge) a.v = snapM(toM(v));
      clampArt(a);
    });
    stopPlacing();
    select('art', a.id);
    toast(`${mountLabel(m)}에 옮겼습니다`);
    return;
  }
  const aw = artInfo(placing.file);
  const aspect = aw.height / aw.width;
  const size = m.spec.default_size || 0.9;
  const a = {
    id: uniqueArtId(), image: aw.file, aspect: round(aspect, 5),
    width: round(aspect >= 1 ? size / aspect : size, 3),
    frame: m.spec.ledge ? 'canvas' : 'black',
    mount: { host: m.host, id: m.spec.id },
    u: m.spec.ledge ? 0 : snapM(toM(u)),
  };
  if (!m.spec.ledge) a.v = snapM(toM(v));
  mutate(() => {
    if (m.spec.ledge) {         // 이젤에는 한 점만: 기존 그림은 내림
      layout.arts = layout.arts.filter((x) => !(x.mount && mkey(x.mount.host, x.mount.id) === m.key));
    }
    layout.arts.push(a);
    clampArt(a);
  });
  if (!keep) stopPlacing();
  select('art', a.id);
  toast(`${mountLabel(m)}에 걸었습니다`);
}
function removeArt(id) {
  mutate(() => {
    layout.arts = layout.arts.filter((a) => a.id !== id);
    if (isSel('art', id)) sel = null;
  });
  toast('그림을 내렸습니다 (그림 파일은 목록에 남아 있습니다)');
}
function editArt(fn) {
  const a = selArt();
  if (!a) return;
  mutate(() => { fn(a); clampArt(a); });
}
function scaleArt(f) { editArt((a) => { a.width = round(a.width * f, 3); }); }

$('artW').addEventListener('change', () => {
  const w = parseFloat($('artW').value);
  if (w > 0) editArt((a) => { a.width = w; });
});
$('artH').addEventListener('change', () => {
  const h = parseFloat($('artH').value);
  if (h > 0) editArt((a) => { a.width = h / a.aspect; });
});
let sliderBefore = null;
$('artScale').addEventListener('input', () => {
  const a = selArt();
  if (!a) return;
  if (sliderBefore === null) sliderBefore = snapshot();
  a.width = parseFloat($('artScale').value);
  clampArt(a);
  refresh();
});
$('artScale').addEventListener('change', () => {
  if (sliderBefore !== null) { const b = sliderBefore; sliderBefore = null; commit(b); }
});
$('artU').addEventListener('change', () => {
  const u = parseFloat($('artU').value);
  if (Number.isFinite(u)) editArt((a) => { a.u = u; });
});
$('artV').addEventListener('change', () => {
  const v = parseFloat($('artV').value);
  if (Number.isFinite(v)) editArt((a) => { a.v = v; });
});
$('artFrame').addEventListener('change', () => editArt((a) => { a.frame = $('artFrame').value; }));
$('artCenter').onclick = () => editArt((a) => { a.u = 0; });
$('artEye').onclick = () => editArt((a) => { a.v = 1.5; });
$('artMove').onclick = () => { const a = selArt(); if (a) startPlacing({ artId: a.id }); };
$('artRemove').onclick = () => { const a = selArt(); if (a) removeArt(a.id); };
for (const id of ['artW', 'artH', 'artU', 'artV']) {
  $(id).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.target.blur(); });
}

// ---------------- 그림 올리기 ----------------
function readImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { reject(new Error(`${file.name}: PNG/JPG/WEBP만 됩니다`)); return; }
    const fr = new FileReader();
    fr.onerror = () => reject(new Error(`${file.name}: 읽기 실패`));
    fr.onload = () => {
      const img = new Image();
      img.onload = () => resolve({ data: fr.result, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error(`${file.name}: 이미지가 아닙니다`));
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
async function uploadFiles(files) {
  const out = [];
  for (const f of files) {
    try {
      toast(`올리는 중: ${f.name}`, 8000);
      const { data, width, height } = await readImage(f);
      const { artwork } = await api.upload({ name: f.name, data, width, height });
      if (!artworks.find((a) => a.file === artwork.file)) artworks.push(artwork);
      out.push(artwork);
    } catch (err) {
      toast('올리기 실패: ' + err.message, 5000);
    }
  }
  refresh();       // 파일이 없던 그림이 다시 올라왔으면 바로 표시
  if (out.length) toast(`그림 ${out.length}점을 올렸습니다`);
  return out;
}
async function deleteArtwork(aw) {
  if (layout.arts.some((a) => a.image === aw.file)) {
    toast('이 방에 걸려 있는 그림입니다. 먼저 내리고 저장하세요', 4000);
    return;
  }
  if (!window.confirm(`"${aw.name}" 그림 파일을 지울까요?`)) return;
  try {
    await api.deleteArt(aw.file);
    artworks = artworks.filter((a) => a.file !== aw.file);
    if (placing && placing.file === aw.file) stopPlacing();
    renderLibrary();
    toast('그림 파일을 지웠습니다');
  } catch (err) {
    toast(err.message, 5000);
  }
}
$('artUpload').onchange = async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = '';
  const done = await uploadFiles(files);
  if (done.length) startPlacing({ file: done[0].file });
};
const vp = $('viewport');
vp.addEventListener('dragover', (ev) => {
  if (![...ev.dataTransfer.types].includes('Files')) return;
  ev.preventDefault();
  $('dropHint').hidden = false;
  showSurfaces(true);
});
vp.addEventListener('dragleave', (ev) => {
  if (vp.contains(ev.relatedTarget)) return;
  $('dropHint').hidden = true;
  if (!placing) showSurfaces(false);
});
vp.addEventListener('drop', async (ev) => {
  ev.preventDefault();
  $('dropHint').hidden = true;
  const pos = { clientX: ev.clientX, clientY: ev.clientY };
  const done = await uploadFiles([...ev.dataTransfer.files]);
  if (!done.length) { if (!placing) showSurfaces(false); return; }
  const hit = raycastSurfaces(pos);
  placing = { file: done[0].file };
  if (hit) placeArtAt(hit, false);
  else startPlacing({ file: done[0].file });
});

// ---------------- 마우스 ----------------
const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 0;
const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function ndc(ev) {
  const r = canvas.getBoundingClientRect();
  let x = ev.clientX - r.left, y = ev.clientY - r.top;
  if (view === 'tv' && tvRect) {
    x = (x - tvRect.x) / tvRect.w * r.width;
    y = (y - (r.height - tvRect.y - tvRect.h)) / tvRect.h * r.height;
  }
  return new THREE.Vector2((x / r.width) * 2 - 1, -(y / r.height) * 2 + 1);
}
function floorPoint(ev) {
  raycaster.setFromCamera(ndc(ev), activeCamera());
  const p = new THREE.Vector3();
  return raycaster.ray.intersectPlane(floor, p) ? { x: p.x, y: -p.z } : null;
}
function raycastSurfaces(ev) {
  raycaster.setFromCamera(ndc(ev), activeCamera());
  const hits = raycaster.intersectObjects(surfaceGroup.children, false);
  if (!hits.length) return null;
  return { key: hits[0].object.userData.mountKey, point: t2b(hits[0].point) };
}
function pick(ev) {
  raycaster.setFromCamera(ndc(ev), activeCamera());
  const targets = [...nodes.values(), ...[...artNodes.values()].map((r) => r.group)];
  if (dollNode) targets.push(dollNode);
  const hits = raycaster.intersectObjects(targets, true)
    .filter((h) => h.object.isMesh && h.object.visible && h.object.name !== 'selOutline');
  for (const h of hits) {
    let o = h.object;
    while (o && !o.userData.itemId && !o.userData.artId && !o.userData.doll) o = o.parent;
    if (!o) continue;
    if (o.userData.artId) return { kind: 'art', id: o.userData.artId };
    if (o.userData.doll) return { kind: 'doll', id: 'doll' };
    return { kind: 'item', id: o.userData.itemId };
  }
  return null;
}

let drag = null;
canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  if (placing) {
    ev.stopImmediatePropagation();
    const hit = raycastSurfaces(ev);
    if (hit) placeArtAt(hit, ev.shiftKey && !placing.artId);
    else toast('벽·가벽·이젤의 파란 면을 클릭하세요');
    return;
  }
  const fp = floorPoint(ev);
  const hit = pick(ev);
  if (fp) lastFloorPoint = { x: fp.x, y: fp.y };
  if (hit && hit.kind === 'art') {
    ev.stopImmediatePropagation();
    sel = hit;
    const a = artById(hit.id);
    const m = artMount(a);
    const sh = raycastSurfaces(ev);
    let off = { du: 0, dv: 0 };
    if (sh && m && sh.key === m.key) {
      const { u, v } = hitUV(m, sh.point);
      const cur = artUV(a, m);
      off = { du: cur.u - u, dv: cur.v - v };
    }
    drag = { kind: 'art', id: hit.id, before: snapshot(), off, moved: false };
    canvas.setPointerCapture(ev.pointerId);
    showSurfaces(true);
    refresh();
  } else if (hit) {
    ev.stopImmediatePropagation();
    sel = hit;
    const p = hit.kind === 'doll' ? layout.doll_spot : itemById(hit.id);
    drag = { kind: hit.kind, id: hit.id, before: snapshot(), off: fp ? { x: p.x - fp.x, y: p.y - fp.y } : { x: 0, y: 0 }, moved: false };
    canvas.setPointerCapture(ev.pointerId);
    refresh();
  } else {
    drag = { kind: null, sx: ev.clientX, sy: ev.clientY };
  }
}, { capture: true });
canvas.addEventListener('pointermove', (ev) => {
  if (!drag || !drag.kind) return;
  if (drag.kind === 'art') {
    const hit = raycastSurfaces(ev);
    if (!hit) return;
    const a = artById(drag.id);
    const m = mounts.get(hit.key);
    if (!a || !m) return;
    if (mkey(a.mount.host, a.mount.id) !== m.key) {
      if (m.host && m.spec.ledge && layout.arts.some((x) => x !== a && x.mount && mkey(x.mount.host, x.mount.id) === m.key)) return;
      a.mount = { host: m.host, id: m.spec.id };
      drag.off = { du: 0, dv: 0 };
    }
    const { u, v } = hitUV(m, hit.point);
    const nu = snapM(toM(u + drag.off.du));
    const nv = snapM(toM(v + drag.off.dv));
    if (nu !== a.u || (!m.spec.ledge && nv !== a.v) || !drag.moved) {
      a.u = nu;
      if (!m.spec.ledge) a.v = nv;
      clampArt(a);
      drag.moved = true;
      refresh();
    }
    return;
  }
  const fp = floorPoint(ev);
  if (!fp) return;
  const p = drag.kind === 'doll' ? layout.doll_spot : itemById(drag.id);
  let nx = snapV(fp.x + drag.off.x), ny = snapV(fp.y + drag.off.y);
  let blocked = false;
  if (drag.kind === 'doll') {
    const q = { x: nx, y: ny };
    clampDoll(q);
    nx = q.x;
    ny = q.y;
  } else {
    const r = constrainMove(p, nx, ny);
    nx = r.x;
    ny = r.y;
    blocked = r.blocked;
  }
  const newBlocked = blocked ? p.id : null;
  if (nx !== p.x || ny !== p.y || newBlocked !== blockedId) {
    p.x = nx;
    p.y = ny;
    blockedId = newBlocked;
    drag.moved = true;
    refresh();
  }
});
canvas.addEventListener('pointerup', (ev) => {
  if (!drag) return;
  if (drag.kind === 'art') showSurfaces(false);
  if (blockedId) { blockedId = null; if (!drag.moved) refresh(); }
  if (drag.kind) {
    if (drag.moved) commit(drag.before);
  } else if (Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) {
    select(null);
  }
  drag = null;
});

// ---------------- 키보드 / 버튼 ----------------
window.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input, select, textarea')) return;
  const k = ev.key.toLowerCase();
  if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if ((ev.ctrlKey || ev.metaKey) && k === 'y') { ev.preventDefault(); redo(); return; }
  if ((ev.ctrlKey || ev.metaKey) && k === 's') { ev.preventDefault(); saveLayout(); return; }
  if ((ev.ctrlKey || ev.metaKey) && k === 'd') { ev.preventDefault(); duplicateSelected(); return; }
  if (k === 'delete' || k === 'backspace') { ev.preventDefault(); removeSelected(); return; }
  if (k === 'escape') { if (placing) stopPlacing(); else select(null); return; }
  if (k === 'r') { rotateSelected(ev.shiftKey ? -rotStep() : rotStep()); return; }
  if (k === '[' || k === '-') { scaleArt(1 / 1.1); return; }
  if (k === ']' || k === '=' || k === '+') { scaleArt(1.1); return; }
  if (k === '1') setView('persp');
  if (k === '2') setView('top');
  if (k === '3') setView('tv');
  const step = gridStep();
  const arrows = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, step], arrowdown: [0, -step] };
  if (arrows[k] && sel) { ev.preventDefault(); moveSelected(...arrows[k]); }
});

document.querySelectorAll('button.view').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
$('undo').onclick = undo;
$('redo').onclick = redo;
$('save').onclick = () => saveLayout();
$('rotL').onclick = () => rotateSelected(rotStep());
$('rotR').onclick = () => rotateSelected(-rotStep());
$('rot90').onclick = () => rotateSelected(90);
$('toWall').onclick = toWall;
$('dup').onclick = duplicateSelected;
$('remove').onclick = removeSelected;
$('replace').onclick = () => replaceSelected($('replaceType').value);
$('snap').onchange = () => requestRender();

function fieldCommit() {
  const p = sel && sel.kind === 'doll' ? layout.doll_spot : selItem();
  if (!p) return;
  const x = parseFloat($('fx').value), y = parseFloat($('fy').value), r = parseFloat($('frot').value);
  let blocked = false;
  mutate(() => {
    const tx = Number.isFinite(x) ? round(fromM(x)) : p.x;
    const ty = Number.isFinite(y) ? round(fromM(y)) : p.y;
    if (p === layout.doll_spot) {
      p.x = tx;
      p.y = ty;
      clampDoll(p);
      return;
    }
    if (Number.isFinite(r)) p.rot = normDeg(r);
    keepInside(p);
    blocked = moveItemTo(p, tx, ty);
  });
  if (blocked) {
    flashBlocked(p.id);
    toast('벽이나 기둥에 막혀 닿는 곳까지만 옮겼습니다');
    refresh();
  }
}
for (const id of ['fx', 'fy', 'frot']) {
  $(id).addEventListener('change', fieldCommit);
  $(id).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.target.blur(); });
}

function defaultLayoutFor(r) {
  const d = (catalog.default_layouts && catalog.default_layouts[r]) || catalog.default_layout;
  return JSON.parse(JSON.stringify(d));
}
$('reset').onclick = () => {
  if (!window.confirm('기본 배치로 되돌릴까요? (실행취소로 복구할 수 있습니다)')) return;
  const d = defaultLayoutFor(roomId);
  mutate(() => {
    layout.items = d.items;
    layout.doll_spot = d.doll_spot;
    layout.arts = d.arts || [];
    sel = null;
  });
};

$('exportFile').onclick = () => {
  const blob = new Blob([JSON.stringify(outputLayout(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = roomId === 'classroom' ? 'layout.json' : `layout_${roomId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('importFile').onchange = async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.items)) throw new Error('items 가 없습니다');
    const unknown = d.items.filter((e) => !types[e.type]);
    mutate(() => {
      layout.items = d.items.filter((e) => types[e.type]);
      layout.storage = Array.isArray(d.storage) ? d.storage.filter((e) => types[e.type]) : [];
      layout.arts = Array.isArray(d.arts) ? d.arts : [];
      if (d.doll_spot) layout.doll_spot = d.doll_spot;
      sel = null;
    });
    toast(unknown.length ? `불러옴 (모르는 가구 ${unknown.length}개 제외)` : '불러왔습니다');
  } catch (err) {
    toast('불러오기 실패: ' + err.message, 4000);
  }
  ev.target.value = '';
};

function outputLayout() {
  for (const a of layout.arts) resolveArt(a);
  return { version: 1, room: roomId, unit_per_m: U, doll_spot: layout.doll_spot, items: layout.items,
    storage: layout.storage, arts: layout.arts };
}
async function saveLayout(quiet = false) {
  try {
    const res = await api.save(roomId, outputLayout());
    setDirty(false);
    if (!quiet) toast(res.rendering ? `저장했습니다 (${room.name}) · TV 배경을 다시 렌더합니다` : `저장했습니다 (${room.name})`);
    pollRender();
    renderLibrary();
    return true;
  } catch (err) {
    toast('저장 실패: ' + err.message, 4000);
    return false;
  }
}
window.addEventListener('beforeunload', (ev) => { if (dirty) { ev.preventDefault(); ev.returnValue = ''; } });

// ---------------- TV 에 보여주기 ----------------
let activeRoom = null;
function showActive() {
  const on = activeRoom === roomId;
  $('setActive').disabled = on;
  $('setActive').textContent = on ? '📺 TV 에 나오는 중' : '📺 TV 에 보여주기';
}
$('setActive').onclick = async () => {
  if (dirty && !(await saveLayout(true))) return;
  try {
    await api.setActive(roomId);
    activeRoom = roomId;
    showActive();
    toast(`TV 화면을 ${room.name}(으)로 바꿨습니다`);
  } catch (err) {
    toast(err.message, 4000);
  }
};

// ---------------- TV 배경 렌더 (맥미니 블렌더) ----------------
let renderTimer = null;
function showRender(st) {
  const el = $('renderStatus');
  $('renderBg').disabled = !st.available;
  if (!st.available) {
    el.textContent = '⚠ 블렌더 없음 (TV 는 실시간 화면)';
    return;
  }
  const mine = st.rooms && st.rooms[roomId];
  if (st.running) {
    const other = st.running !== roomId ? ` [${catalog.rooms[st.running]?.name ?? st.running}]` : '';
    el.textContent = `⏳ 배경 렌더 중${other} ${st.elapsed}초`;
  } else if (st.pending.includes(roomId)) {
    el.textContent = '⏳ 배경 렌더 대기';
  } else if (st.last && st.last.room === roomId && !st.last.ok) {
    el.textContent = '❌ 배경 렌더 실패 (서버 data/world/render/render.log)';
  } else if (!mine) {
    el.textContent = '배경 렌더 없음';
  } else {
    el.textContent = mine.stale ? '● 배경이 옛 배치' : `✅ 배경 ${new Date(mine.rendered_at * 1000).toLocaleTimeString()}`;
  }
}
async function pollRender() {
  clearTimeout(renderTimer);
  try {
    const { render } = await api.renderStatus();
    showRender(render);
    if (render.running || render.pending.length) renderTimer = setTimeout(pollRender, 3000);
  } catch { /* 서버가 잠깐 없음 */ }
}
$('renderBg').onclick = async () => {
  if (dirty && !(await saveLayout(true))) return;
  try {
    await api.render(roomId);
    toast(`${room.name} 배경을 렌더합니다 (몇 분 걸립니다)`);
  } catch (err) {
    toast(err.message, 5000);
  }
  pollRender();
};

// ---------------- 방 불러오기 / 전환 ----------------
new ResizeObserver(requestRender).observe(canvas);

function clearScene() {
  for (const n of nodes.values()) scene.remove(n);
  nodes.clear();
  for (const r of artNodes.values()) { scene.remove(r.group); disposeGroup(r.group); }
  artNodes.clear();
  if (shellNode) scene.remove(shellNode);
  shellNode = null;
  ceilingParts = [];
}

async function loadRoom(r) {
  $('loading').hidden = false;
  $('loading').textContent = '불러오는 중…';
  if (placing) stopPlacing();
  const st = await api.state(r);
  if (!st.catalog || !st.catalog.rooms) {
    $('loading').textContent = '맵 카탈로그가 없습니다. 리본 프로젝트에서 python tools/sync_world.py 를 실행하세요';
    return;
  }
  catalog = st.catalog;
  roomId = r;
  room = catalog.rooms[r];
  U = room.unit_per_m;
  for (const k of Object.keys(types)) delete types[k];
  for (const t of catalog.types) types[t.id] = t;
  artworks = st.artworks || [];
  const src = st.layout || defaultLayoutFor(r);
  layout = {
    doll_spot: src.doll_spot || defaultLayoutFor(r).doll_spot,
    items: (src.items || []).filter((e) => types[e.type]),
    storage: (src.storage || []).filter((e) => types[e.type]),
    arts: src.arts || [],
  };
  sel = null;
  history.length = 0;
  future.length = 0;
  clearScene();
  setupCameras();
  activeCat = null;
  renderCatalog();
  $('room').value = r;
  document.title = `맵 편집기 · ${room.name}`;
  if (location.hash !== `#${r}`) window.history.replaceState(null, '', `#${r}`);

  activeRoom = st.active;
  showActive();
  if (st.render) { showRender(st.render); pollRender(); }
  const shell = await loader.loadAsync(`${MODEL_BASE}${room.shell}?v=${cacheBust}`);
  shellNode = shell.scene;
  shellNode.traverse((o) => { if (/^Ceiling/.test(o.name)) ceilingParts.push(o); });
  scene.add(shellNode);
  if (!dollNode) {
    try {
      const doll = await loadDoll();
      dollNode = new THREE.Group();
      dollNode.userData = { doll: true };
      dollNode.add(doll.scene);
      scene.add(dollNode);
    } catch {
      toast('world/doll.glb 가 없어 리본이 자리는 목록에서만 편집할 수 있습니다', 4000);
    }
  }
  refresh();
  setDirty(false);
  $('loading').hidden = true;
  if (!st.has_layout_file) toast(`${room.name} 배치 파일이 없어 기본 배치로 시작합니다. 저장하면 파일이 만들어집니다.`, 4000);
}

$('room').onchange = async () => {
  const r = $('room').value;
  if (r === roomId) return;
  if (dirty && !window.confirm('저장하지 않은 변경이 있습니다. 저장하지 않고 방을 바꿀까요?')) {
    $('room').value = roomId;
    return;
  }
  if (r === 'gallery' || r.startsWith('kid:')) {
    // 전시장과 아이 전시실은 가구 없이 작품만 건다: 전시실 꾸미기 화면에서 (index.ts addGalleries)
    const embed = new URLSearchParams(location.search).has('embed') ? '&embed=1' : '';
    location.href = r === 'gallery' ? `/?mode=art&room=gallery${embed}`
      : `/?mode=art&kid=${encodeURIComponent(r.slice(4))}${embed}`;
    return;
  }
  try {
    await loadRoom(r);
  } catch (err) {
    toast('방 불러오기 실패: ' + err.message, 5000);
  }
};

if (location.hash === '#gallery') {       // 예전 주소로 들어왔다: 전시장은 이제 전시실 꾸미기에서
  location.replace(`/?mode=art&room=gallery${new URLSearchParams(location.search).has('embed') ? '&embed=1' : ''}`);
}
const startRoom = 'classroom';
loadRoom(startRoom).catch((err) => {
  $('loading').textContent = '시작 실패: ' + err.message;
  console.error(err);
});
