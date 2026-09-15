import { Application } from "pixi.js";
import type { AppConfig, KidInfo, RibbonConfig, ServerMsg } from "../protocol";
import type { RibbonSocket } from "../ws";
import { AvatarSprite } from "../tv/avatar";
import { RibbonSprite } from "../tv/ribbon";

/**
 * 관리자 페이지 (?mode=admin). 아이 아바타와 리본이 설정을 고치고 저장한다.
 * 저장은 REST API 로, 화면 반영은 서버가 보내는 state 브로드캐스트로 이뤄진다.
 */
const VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];
const HAIR_LABEL: Record<string, string> = { short: "짧은 머리", bowl: "바가지", twin: "양갈래", spiky: "뾰족", long: "긴 머리", curly: "곱슬", bun: "똥머리" };

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("json") ? await res.json() : await res.blob()) as T;
}

/** 작은 Pixi 스테이지에 캐릭터 하나를 4배로 띄운다. */
async function mountPreview(el: HTMLElement, w = 160, h = 160): Promise<Application> {
  const app = new Application();
  await app.init({ width: w, height: h, background: 0x1b1626, antialias: false, resolution: 1, roundPixels: true });
  el.innerHTML = "";
  el.appendChild(app.canvas);
  app.stage.scale.set(4);
  return app;
}

export async function startAdmin(socket: RibbonSocket): Promise<void> {
  const root = document.getElementById("app")!;
  root.innerHTML = `
  <div id="admin">
    <h1>리본 관리자</h1>
    <div class="grid">
      <section class="card">
        <h2>아이들</h2>
        <div class="kid-row">
          <ul id="kid-list"></ul>
          <div>
            <button id="kid-new">+ 새 아이</button>
            <div id="kid-preview" class="preview"></div>
          </div>
        </div>
        <form id="kid-form" hidden>
          <input type="hidden" name="id" />
          <label>이름 <input name="name" required /></label>
          <label>나이 <input name="age" type="number" min="3" max="13" /></label>
          <label>마이크 채널 <select name="mic_channel"><option value="">없음</option><option>0</option><option>1</option><option>2</option><option>3</option></select></label>
          <label>자리 <select name="seat"><option>0</option><option>1</option><option>2</option><option>3</option></select></label>
          <label>머리 모양 <select name="hair"></select></label>
          <label>머리 색 <input name="hair_color" type="color" /></label>
          <label>피부 색 <input name="skin" type="color" /></label>
          <label>옷 색 <input name="top" type="color" /></label>
          <label>스프라이트 세트 (client/public/characters/ 폴더 이름, 예: kid_jiwoo) <input name="sprite_set" placeholder="비우면 조립식 도트 아바타" /></label>
          <label>직접 그린 스프라이트 (PNG, 세로 24px 권장)
            <input name="sprite_file" type="file" accept="image/png,image/gif,image/webp" />
          </label>
          <div class="sprite-row"><span id="sprite-current">스프라이트 없음</span> <button type="button" id="sprite-clear">스프라이트 제거</button></div>
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
              <label>몸 <input name="body" type="color" /></label>
              <label>날개 <input name="wing" type="color" /></label>
              <label>머리 리본 <input name="bow" type="color" /></label>
              <label>볼 <input name="cheek" type="color" /></label>
            </div>
            <label>미리 듣기 문장 <input name="preview_text" value="안녕, 나는 리본이야. 오늘은 무슨 그림을 그렸어?" /></label>
            <div class="actions"><button type="button" id="tts-preview">🔊 미리 듣기</button><button type="submit">저장</button></div>
          </form>
          <div id="ribbon-preview" class="preview"></div>
        </div>
      </section>
    </div>
    <p id="admin-msg" class="msg"></p>
    <section class="card" id="room-card">
      <h2>방 꾸미기</h2>
      <div id="room-editor"></div>
    </section>
  </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const msg = (t: string, err = false) => { const el = $("#admin-msg"); el.textContent = t; el.style.color = err ? "#f88" : "#8f8"; };

  let kids: KidInfo[] = [];
  let config: AppConfig | null = null;
  let selected: KidInfo | null = null;

  // ---- 미리보기 ----
  const kidApp = await mountPreview($("#kid-preview"));
  const ribbonApp = await mountPreview($("#ribbon-preview"));
  let previewAvatar: AvatarSprite | null = null;
  const previewRibbon = new RibbonSprite();
  previewRibbon.x = 20; previewRibbon.y = 36;
  ribbonApp.stage.addChild(previewRibbon);
  ribbonApp.ticker.add((t) => { previewRibbon.lookAround(performance.now()); previewRibbon.update(t.deltaMS); });
  kidApp.ticker.add((t) => previewAvatar?.update(t.deltaMS));

  function kidFromForm(): Partial<KidInfo> & { avatar: Record<string, string> } {
    const f = $("#kid-form") as HTMLFormElement;
    const d = new FormData(f);
    const s = (k: string) => String(d.get(k) ?? "");
    return {
      id: s("id") || undefined,
      name: s("name").trim(),
      age: s("age") ? Number(s("age")) : null,
      mic_channel: s("mic_channel") === "" ? null : Number(s("mic_channel")),
      seat: Number(s("seat")),
      avatar: { hair: s("hair"), hair_color: s("hair_color"), skin: s("skin"), top: s("top"), sprite_url: selected?.avatar?.sprite_url ?? "", sprite_set: s("sprite_set").trim() },
    };
  }

  function refreshKidPreview(): void {
    const data = kidFromForm();
    const kid: KidInfo = { id: data.id ?? "preview", name: data.name || "?", avatar: data.avatar, present: true, seat: data.seat, mic_channel: data.mic_channel, age: data.age };
    if (previewAvatar) { kidApp.stage.removeChild(previewAvatar); previewAvatar.destroy(); }
    previewAvatar = new AvatarSprite(kid, { bx: 20, t: 34 }, { toScreen: (p) => ({ x: p.bx, y: p.t, s: 1 }) });
    kidApp.stage.addChild(previewAvatar);
  }

  // ---- 아이 목록/폼 ----
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

  function fillHairOptions(): void {
    const sel = $("#kid-form select[name=hair]") as HTMLSelectElement;
    sel.innerHTML = "";
    for (const h of config?.avatar_options?.hair ?? ["short", "bowl", "twin", "spiky"]) {
      const o = document.createElement("option"); o.value = h; o.textContent = HAIR_LABEL[h] ?? h; sel.appendChild(o);
    }
  }

  function selectKid(k: KidInfo | null): void {
    selected = k;
    const f = $("#kid-form") as HTMLFormElement;
    f.hidden = false;
    const set = (n: string, v: string) => { (f.elements.namedItem(n) as HTMLInputElement).value = v; };
    set("id", k?.id ?? "");
    set("name", k?.name ?? "");
    set("age", k?.age != null ? String(k.age) : "");
    set("mic_channel", k?.mic_channel != null ? String(k.mic_channel) : "");
    set("seat", String(k?.seat ?? 0));
    set("hair", k?.avatar?.hair ?? "short");
    set("hair_color", k?.avatar?.hair_color ?? "#3b2a1a");
    set("skin", k?.avatar?.skin ?? "#f2c9a0");
    set("top", k?.avatar?.top ?? "#e74c3c");
    set("sprite_set", k?.avatar?.sprite_set ?? "");
    $("#sprite-current").textContent = k?.avatar?.sprite_url ? `스프라이트: ${k.avatar.sprite_url}` : "스프라이트 없음";
    (f.elements.namedItem("sprite_file") as HTMLInputElement).value = "";
    $("#kid-delete").hidden = !k;
    renderKidList();
    refreshKidPreview();
  }

  $("#kid-new").onclick = () => selectKid(null);
  $("#kid-form").oninput = () => refreshKidPreview();
  $("#sprite-clear").onclick = () => { if (selected) { selected = { ...selected, avatar: { ...selected.avatar, sprite_url: "" } }; $("#sprite-current").textContent = "스프라이트 없음"; refreshKidPreview(); } };

  ($("#kid-form") as HTMLFormElement).onsubmit = async (e) => {
    e.preventDefault();
    try {
      const data = kidFromForm();
      const fileInput = $("#kid-form input[name=sprite_file]") as HTMLInputElement;
      if (fileInput.files?.[0]) {
        const fd = new FormData(); fd.append("file", fileInput.files[0]);
        const up = await api<{ url: string }>("POST", "/api/assets", fd);
        data.avatar.sprite_url = up.url;
      }
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
    try { await api("DELETE", `/api/kids/${selected.id}`); msg("삭제됨"); selected = null; ($("#kid-form") as HTMLFormElement).hidden = true; }
    catch (err) { msg(String(err), true); }
  };

  // ---- 리본이 ----
  const rf = $("#ribbon-form") as HTMLFormElement;
  const voiceSel = rf.elements.namedItem("voice") as HTMLSelectElement;
  for (const v of VOICES) { const o = document.createElement("option"); o.value = v; o.textContent = v.startsWith("F") ? `여성 ${v}` : `남성 ${v}`; voiceSel.appendChild(o); }

  function fillRibbonForm(rc: RibbonConfig): void {
    const set = (n: string, v: string) => { (rf.elements.namedItem(n) as HTMLInputElement).value = v; };
    set("name", rc.name); set("voice", rc.voice); set("speed", String(rc.speed)); set("steps", String(rc.steps));
    set("pitch", String(rc.pitch ?? 0));
    set("max_sentences", String(rc.max_sentences)); set("persona_extra", rc.persona_extra ?? "");
    set("body", rc.colors.body); set("wing", rc.colors.wing); set("bow", rc.colors.bow); set("cheek", rc.colors.cheek);
    $("#speed-out").textContent = String(rc.speed); $("#steps-out").textContent = String(rc.steps);
    $("#pitch-out").textContent = String(rc.pitch ?? 0);
    previewRibbon.setColors(rc.colors);
  }

  function ribbonFromForm(): Partial<RibbonConfig> {
    const d = new FormData(rf);
    const s = (k: string) => String(d.get(k) ?? "");
    return {
      name: s("name").trim() || "리본", voice: s("voice"), speed: Number(s("speed")), steps: Number(s("steps")),
      pitch: Number(s("pitch")) || 0,
      max_sentences: Number(s("max_sentences")) || 3, persona_extra: s("persona_extra"),
      colors: { body: s("body"), wing: s("wing"), bow: s("bow"), cheek: s("cheek") },
    };
  }

  rf.oninput = () => {
    const rc = ribbonFromForm();
    $("#speed-out").textContent = String(rc.speed); $("#steps-out").textContent = String(rc.steps);
    $("#pitch-out").textContent = String(rc.pitch);
    previewRibbon.setColors(rc.colors);
  };
  rf.onsubmit = async (e) => {
    e.preventDefault();
    try { await api("PUT", "/api/config/ribbon", ribbonFromForm()); msg("리본이 설정 저장됨"); }
    catch (err) { msg(String(err), true); }
  };
  $("#tts-preview").onclick = async () => {
    const rc = ribbonFromForm();
    const text = (rf.elements.namedItem("preview_text") as HTMLInputElement).value;
    msg("합성 중...");
    try {
      const blob = await api<Blob>("POST", "/api/tts/preview", { text, voice: rc.voice, speed: rc.speed, steps: rc.steps, pitch: rc.pitch });
      const audio = new Audio(URL.createObjectURL(blob));
      previewRibbon.setState("speaking");
      audio.onended = () => previewRibbon.setState("idle");
      await audio.play();
      msg(`${rc.voice} 재생 중`);
    } catch (err) { msg(String(err), true); previewRibbon.setState("idle"); }
  };

  // ---- 방 꾸미기 ----
  const { mountRoomEditor } = await import("./room");
  const roomEditor = await mountRoomEditor($("#room-editor"), { api, getKids: () => kids, onMessage: msg });

  // ---- 서버 상태 반영 ----
  socket.on((m: ServerMsg) => {
    if (m.type !== "state") return;
    kids = m.kids;
    const cfg = m.config as AppConfig | undefined;
    const first = !config;
    if (cfg?.ribbon) {
      config = cfg;
      if (first) { fillHairOptions(); fillRibbonForm(cfg.ribbon); }
    }
    if (cfg?.room) roomEditor.setSpec(cfg.room);
    roomEditor.setKids(kids);
    if (selected) selected = kids.find((k) => k.id === selected!.id) ?? selected;
    renderKidList();
  });
}
