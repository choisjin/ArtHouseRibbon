import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { AppConfig, KidInfo, RibbonConfig, ServerMsg } from "../protocol";
import type { RibbonSocket } from "../ws";
import { Ribbon3D } from "../tv/ribbon3d";
import { DEFAULT_LOOK, type RibbonLook } from "../world/doll";
import type { Catalog } from "../world/types";

/**
 * 관리자 페이지 (?mode=admin). 아이 목록, 리본이 목소리·겉모습·돌아다니기, TV 에 보여줄 방.
 * 가구 배치와 그림은 맵 편집기(?mode=editor)에서 한다.
 * 저장은 REST API 로, 화면 반영은 서버가 보내는 state 브로드캐스트로 이뤄진다.
 */
const VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("json") ? await res.json() : await res.blob()) as T;
}

/** 리본이 3D 미리보기: 천천히 도는 받침 위에 인형 하나 */
function mountRibbonPreview(el: HTMLElement): Ribbon3D {
  const W = 240, H = 300;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.AgXToneMapping;
  el.innerHTML = "";
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1626);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xcdbba8, 0.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(3, 8, 6);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 50);
  const ribbon = new Ribbon3D();
  const turntable = new THREE.Group();
  turntable.add(ribbon.root);
  scene.add(turntable);
  void ribbon.loaded.then(() => {
    const h = ribbon.height;
    camera.position.set(0, h * 0.62, h * 2.6);
    camera.lookAt(0, h * 0.48, 0);
  });
  let drag: number | null = null;
  let spin = 0;
  renderer.domElement.title = "드래그해서 돌려 보기";
  renderer.domElement.onpointerdown = (e) => { drag = e.clientX; renderer.domElement.setPointerCapture(e.pointerId); };
  renderer.domElement.onpointermove = (e) => { if (drag !== null) { spin += (e.clientX - drag) * 0.01; drag = e.clientX; } };
  renderer.domElement.onpointerup = () => { drag = null; };
  const clock = new THREE.Clock();
  const tick = () => {
    const dt = Math.min(clock.getDelta(), 0.1);
    if (drag === null) spin += dt * 0.35;
    turntable.rotation.y = Math.sin(spin) * 0.9;
    ribbon.update(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return ribbon;
}

export async function startAdmin(socket: RibbonSocket): Promise<void> {
  const root = document.getElementById("app")!;
  root.innerHTML = `
  <div id="admin">
    <h1>리본 관리자</h1>
    <div class="grid">
      <section class="card">
        <h2>아이들</h2>
        <p class="hint">TV 화면에는 아이들이 나오지 않습니다. 이름과 마이크 채널로 누가 말하는지 알아봅니다.</p>
        <div class="kid-row">
          <ul id="kid-list"></ul>
          <div><button id="kid-new">+ 새 아이</button></div>
        </div>
        <form id="kid-form" hidden>
          <input type="hidden" name="id" />
          <label>이름 <input name="name" required /></label>
          <label>나이 <input name="age" type="number" min="3" max="13" /></label>
          <label>마이크 채널 <select name="mic_channel"><option value="">없음</option><option>0</option><option>1</option><option>2</option><option>3</option></select></label>
          <div class="actions"><button type="submit">저장</button><button type="button" id="kid-delete" class="danger">삭제</button></div>
        </form>
      </section>
      <section class="card">
        <h2>리본이</h2>
        <div class="kid-row">
          <form id="ribbon-form">
            <label>이름 <input name="name" required /></label>
            <label>목소리 <select name="voice"></select></label>
            <label>속도 <input name="speed" type="range" min="0.7" max="2" step="0.05" /> <output id="speed-out"></output></label>
            <label>품질 <input name="steps" type="range" min="5" max="12" step="1" /> <output id="steps-out"></output></label>
            <label>피치 (반음, 어린아이 느낌은 +3 ~ +5) <input name="pitch" type="range" min="-6" max="8" step="0.5" /> <output id="pitch-out"></output></label>
            <label>한 번에 최대 문장 수 <input name="max_sentences" type="number" min="1" max="6" /></label>
            <label>성격 추가 지시문 <textarea name="persona_extra" rows="4" placeholder="예: 그림 이야기를 할 때 색 이름을 영어로도 한 번 말해준다."></textarea></label>
            <div class="colors">
              <label class="inline"><input name="ack_enabled" type="checkbox" /> 인식 즉시 반응 ("알았어, 잠깐 생각해 볼게!")</label>
              <label class="inline"><input name="filler_enabled" type="checkbox" /> 답이 늦으면 추임새 ("음...")</label>
            </div>
            <div class="colors">
              <label>첫 추임새까지 (초) <input name="filler_delay_s" type="number" step="0.5" min="0.5" max="10" /></label>
              <label>추임새 간격 (초) <input name="filler_interval_s" type="number" step="0.5" min="1" max="15" /></label>
            </div>
            <fieldset>
              <legend>겉모습</legend>
              <label>옷 <select name="outfit"><option value="onepiece">민트 원피스</option><option value="twopiece">블라우스 + 주름치마</option></select></label>
              <div class="colors">
                <label>머리 <input name="hair" type="color" /></label>
                <label>머리 리본 <input name="bow" type="color" /></label>
                <label>원피스·치마 <input name="dress" type="color" /></label>
                <label>블라우스 <input name="blouse" type="color" /></label>
              </div>
              <div class="actions"><button type="button" id="look-reset">기본 색으로</button></div>
            </fieldset>
            <fieldset>
              <legend>맵에서 움직이기</legend>
              <label class="inline"><input name="wander" type="checkbox" /> 평소에 방을 돌아다니기 (끄면 "부르면 오는 자리"에 서 있음)</label>
              <label>걷는 속도 <input name="walk_speed" type="range" min="0.5" max="2" step="0.1" /> <output id="walk-out"></output></label>
              <label>대화가 끝나고 다시 돌아다니기까지 (초) <input name="return_after_s" type="number" step="1" min="0" max="120" /></label>
              <p class="hint">부르면 그 자리에서 멈춰 TV 쪽을 보고 손을 흔든 뒤, 맵 편집기에서 정한 "부르면 오는 자리"로 걸어옵니다.</p>
            </fieldset>
            <label>미리 듣기 문장 <input name="preview_text" value="안녕, 나는 리본이야. 오늘은 무슨 그림을 그렸어?" /></label>
            <div class="actions"><button type="button" id="tts-preview">🔊 미리 듣기</button><button type="button" id="greet-preview">👋 인사</button><button type="submit">저장</button></div>
          </form>
          <div id="ribbon-preview" class="preview"></div>
        </div>
      </section>
      <section class="card">
        <h2>맵</h2>
        <form id="world-form">
          <label>TV 에 보여줄 방 <select name="room"></select></label>
          <p id="render-info" class="hint"></p>
          <div class="actions"><a class="button" id="editor-link" href="/?mode=editor" target="_blank">🪑 맵 편집기 열기</a></div>
          <p class="hint">맵 편집기에서 가구를 옮기고, 그림을 벽·가벽·이젤에 걸고, 리본이가 "부르면 오는 자리"를 정합니다.
            저장하면 이 맥의 블렌더가 TV 배경을 다시 렌더하고(몇 분), 끝나면 TV 가 새 배경으로 바뀝니다. 블렌더가 없으면 TV 는 실시간 3D 화면입니다.</p>
          <p class="hint">가구·방·인형 모델은 Character_Creator(블렌더)에서 만들고 <code>python tools/sync_world.py</code> 로 가져옵니다.</p>
        </form>
      </section>
    </div>
    <p id="admin-msg" class="msg"></p>
  </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const msg = (t: string, err = false) => { const el = $("#admin-msg"); el.textContent = t; el.style.color = err ? "#f88" : "#8f8"; };

  let kids: KidInfo[] = [];
  let config: AppConfig | null = null;
  let selected: KidInfo | null = null;

  // ---- 아이 목록/폼 ----
  const kf = $("#kid-form") as HTMLFormElement;

  function renderKidList(): void {
    const ul = $("#kid-list");
    ul.innerHTML = "";
    for (const k of kids) {
      const li = document.createElement("li");
      li.textContent = `${k.name}${k.mic_channel != null ? ` (마이크 ${k.mic_channel})` : ""}`;
      li.className = selected?.id === k.id ? "sel" : "";
      li.onclick = () => selectKid(k);
      ul.appendChild(li);
    }
  }

  function selectKid(k: KidInfo | null): void {
    selected = k;
    kf.hidden = false;
    const set = (n: string, v: string) => { (kf.elements.namedItem(n) as HTMLInputElement).value = v; };
    set("id", k?.id ?? "");
    set("name", k?.name ?? "");
    set("age", k?.age != null ? String(k.age) : "");
    set("mic_channel", k?.mic_channel != null ? String(k.mic_channel) : "");
    $("#kid-delete").hidden = !k;
    renderKidList();
  }

  $("#kid-new").onclick = () => selectKid(null);

  kf.onsubmit = async (e) => {
    e.preventDefault();
    const d = new FormData(kf);
    const s = (k: string) => String(d.get(k) ?? "");
    const data = {
      id: s("id") || undefined,
      name: s("name").trim(),
      age: s("age") ? Number(s("age")) : null,
      mic_channel: s("mic_channel") === "" ? null : Number(s("mic_channel")),
      seat: selected?.seat ?? 0,
      avatar: selected?.avatar ?? {},
    };
    try {
      const saved = data.id
        ? await api<KidInfo>("PUT", `/api/kids/${data.id}`, data)
        : await api<KidInfo>("POST", "/api/kids", data);
      msg(`${saved.name} 저장됨`);
      selected = saved;
    } catch (err) { msg(String(err), true); }
  };

  $("#kid-delete").onclick = async () => {
    if (!selected) return;
    if (!confirm(`${selected.name} 을(를) 삭제할까요?`)) return;
    try { await api("DELETE", `/api/kids/${selected.id}`); msg("삭제됨"); selected = null; kf.hidden = true; }
    catch (err) { msg(String(err), true); }
  };

  // ---- 리본이 ----
  const preview = mountRibbonPreview($("#ribbon-preview"));
  const rf = $("#ribbon-form") as HTMLFormElement;
  const field = (n: string) => rf.elements.namedItem(n) as HTMLInputElement;
  const voiceSel = rf.elements.namedItem("voice") as HTMLSelectElement;
  for (const v of VOICES) { const o = document.createElement("option"); o.value = v; o.textContent = v.startsWith("F") ? `여성 ${v}` : `남성 ${v}`; voiceSel.appendChild(o); }

  function fillLook(look: Partial<RibbonLook> | undefined): void {
    const l = { ...DEFAULT_LOOK, ...(look ?? {}) };
    for (const k of Object.keys(DEFAULT_LOOK) as (keyof RibbonLook)[]) field(k).value = l[k];
    preview.setLook(l);
  }

  function showOutputs(rc: Partial<RibbonConfig>): void {
    $("#speed-out").textContent = String(rc.speed);
    $("#steps-out").textContent = String(rc.steps);
    $("#pitch-out").textContent = String(rc.pitch ?? 0);
    $("#walk-out").textContent = `×${rc.walk_speed ?? 1}`;
  }

  function fillRibbonForm(rc: RibbonConfig): void {
    const set = (n: string, v: string) => { field(n).value = v; };
    set("name", rc.name); set("voice", rc.voice); set("speed", String(rc.speed)); set("steps", String(rc.steps));
    set("pitch", String(rc.pitch ?? 0));
    set("max_sentences", String(rc.max_sentences)); set("persona_extra", rc.persona_extra ?? "");
    field("ack_enabled").checked = rc.ack_enabled ?? true;
    field("filler_enabled").checked = rc.filler_enabled ?? true;
    set("filler_delay_s", String(rc.filler_delay_s ?? 1.5)); set("filler_interval_s", String(rc.filler_interval_s ?? 4));
    field("wander").checked = rc.wander ?? true;
    set("walk_speed", String(rc.walk_speed ?? 1));
    set("return_after_s", String(rc.return_after_s ?? 8));
    fillLook(rc.look);
    showOutputs(rc);
  }

  function lookFromForm(): RibbonLook {
    return {
      outfit: field("outfit").value === "twopiece" ? "twopiece" : "onepiece",
      hair: field("hair").value, bow: field("bow").value, dress: field("dress").value, blouse: field("blouse").value,
    };
  }

  function ribbonFromForm(): Partial<RibbonConfig> {
    const d = new FormData(rf);
    const s = (k: string) => String(d.get(k) ?? "");
    return {
      name: s("name").trim() || "리본", voice: s("voice"), speed: Number(s("speed")), steps: Number(s("steps")),
      pitch: Number(s("pitch")) || 0,
      max_sentences: Number(s("max_sentences")) || 3, persona_extra: s("persona_extra"),
      ack_enabled: field("ack_enabled").checked,
      filler_enabled: field("filler_enabled").checked,
      filler_delay_s: Number(s("filler_delay_s")) || 1.5, filler_interval_s: Number(s("filler_interval_s")) || 4,
      look: lookFromForm(),
      wander: field("wander").checked,
      walk_speed: Number(s("walk_speed")) || 1,
      return_after_s: Number(s("return_after_s")) || 0,
    };
  }

  rf.oninput = () => {
    const rc = ribbonFromForm();
    showOutputs(rc);
    preview.setLook(rc.look);
  };
  $("#look-reset").onclick = () => fillLook({ outfit: lookFromForm().outfit });
  rf.onsubmit = async (e) => {
    e.preventDefault();
    try { await api("PUT", "/api/config/ribbon", ribbonFromForm()); msg("리본이 설정 저장됨"); }
    catch (err) { msg(String(err), true); }
  };
  $("#greet-preview").onclick = () => preview.greet();
  $("#tts-preview").onclick = async () => {
    const rc = ribbonFromForm();
    const text = field("preview_text").value;
    msg("합성 중...");
    try {
      const blob = await api<Blob>("POST", "/api/tts/preview", { text, voice: rc.voice, speed: rc.speed, steps: rc.steps, pitch: rc.pitch });
      const audio = new Audio(URL.createObjectURL(blob));
      // 말하는 동안 고개 끄덕임 (실제 음량 대신 흔들림)
      const talk = window.setInterval(() => preview.setMouthLevel(0.3 + Math.random() * 0.7), 120);
      const done = () => { clearInterval(talk); preview.setMouthLevel(0); preview.setState("idle"); };
      preview.setState("speaking");
      audio.onended = done;
      await audio.play().catch((err) => { done(); throw err; });
      msg(`${rc.voice} 재생 중`);
    } catch (err) { msg(String(err), true); preview.setState("idle"); }
  };

  // ---- 맵 ----
  const roomSel = $("#world-form select[name=room]") as HTMLSelectElement;
  try {
    const w = await api<{ active: string; catalog: Catalog }>("GET", "/api/world");
    for (const [id, r] of Object.entries(w.catalog.rooms ?? {})) {
      const o = document.createElement("option"); o.value = id; o.textContent = r.name; roomSel.appendChild(o);
    }
    roomSel.value = w.active;
  } catch (err) { msg(`맵 정보를 못 읽음: ${err}`, true); }
  const syncLink = () => { ($("#editor-link") as HTMLAnchorElement).href = `/?mode=editor#${roomSel.value}`; };
  syncLink();
  roomSel.onchange = async () => {
    syncLink();
    try { await api("PUT", "/api/world/active", { room: roomSel.value }); msg(`TV 방: ${roomSel.selectedOptions[0]?.textContent}`); }
    catch (err) { msg(String(err), true); }
  };

  // ---- 서버 상태 반영 ----
  socket.on((m: ServerMsg) => {
    if (m.type !== "state") return;
    kids = m.kids;
    const cfg = m.config as AppConfig | undefined;
    if (cfg?.ribbon) {
      if (!config) fillRibbonForm(cfg.ribbon);
      config = cfg;
    }
    if (cfg?.world && document.activeElement !== roomSel) { roomSel.value = cfg.world.room; syncLink(); }
    if (cfg?.world) {
      const w = cfg.world, r = w.render;
      $("#render-info").textContent =
        (w.rendering ? `⏳ 배경 렌더 중 (${w.rendering}) · ` : "") +
        (r ? `TV 배경: 블렌더 렌더 ${new Date(r.rendered_at * 1000).toLocaleString()}${r.stale ? " (배치가 바뀌어 다시 렌더 필요)" : ""}`
           : "TV 배경: 렌더 없음 → 실시간 3D");
    }
    if (selected) selected = kids.find((k) => k.id === selected!.id) ?? selected;
    renderKidList();
  });
}
