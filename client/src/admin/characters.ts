import type { CharacterProfile, RibbonConfig } from "../protocol";
import type { Ribbon3D } from "../tv/ribbon3d";
import { CHARACTERS, characterOf, DEFAULT_CHARACTER, DEFAULT_LOOK, type RibbonLook } from "../world/doll";
import { mountPromises } from "./promises";
import { api, type AdminCtx, esc, mountPreview, snapshot } from "./shared";

/** 서버 ribbon/voices.py 의 목소리 (기본 10개 + 섞은 조합) */
interface VoiceInfo { id: string; name: string; group: string; speed: number | null }

/**
 * 캐릭터 탭.
 *   목록(#characters)       : TV 에 나올 캐릭터(주인공·친구), 캐릭터별 프로필 카드, 대화·움직임 공통 설정
 *   설정(#characters/<id>)  : 이력서처럼 오른쪽 위에 캐릭터 모습, 이름·소개·성격·목소리·옷
 * 프로필은 서버 settings_store.CharacterProfile. 주인공 프로필이 대화(이름·성격)와 목소리에 쓰인다.
 */
const TINT_NAME: Record<string, string> = { hair: "머리", bow: "머리 리본", dress: "원피스·치마", blouse: "블라우스" };

export function mountCharacters(el: HTMLElement, ctx: AdminCtx): { show(id?: string): void } {
  const shots = new Map<string, string>();       // 캐릭터 id + 옷·색 → 사진 dataURL
  let voices: VoiceInfo[] = [];                   // 서버에서 한 번 읽는다
  const commonPromisesEl = document.createElement("div");   // 목록을 다시 그려도 같은 것을 다시 붙인다
  const commonPromises = mountPromises(commonPromisesEl, ctx);
  let current: string | undefined;                // 지금 보는 설정 페이지
  let rendered = "";                              // 목록을 마지막으로 그린 설정 (같으면 다시 안 그림)

  const profileOf = (id: string): CharacterProfile | undefined => ctx.config()?.characters?.[id];
  const rc = (): RibbonConfig | undefined => ctx.config()?.ribbon;
  const roleOf = (id: string): "main" | "friend" | "" => {
    const r = rc();
    return r?.character === id || (!r?.character && id === DEFAULT_CHARACTER) ? "main" : r?.friend === id ? "friend" : "";
  };
  const ROLE = { main: "주인공", friend: "같이 나오는 친구", "": "쉬는 중" };

  const voiceOf = (id: string): VoiceInfo | undefined => voices.find((v) => v.id === id);
  const voiceName = (id: string): string => {
    const v = voiceOf(id);
    return !v ? id : v.group === "기본 목소리" ? v.name : `${v.group.replace(/ \(.*\)$/, "")} · ${v.name}`;
  };
  const voiceOptions = (): string => {
    const groups = new Map<string, VoiceInfo[]>();
    for (const v of voices) groups.set(v.group, [...(groups.get(v.group) ?? []), v]);
    return [...groups].map(([g, vs]) => `<optgroup label="${esc(g)}">${vs.map((v) =>
      `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join("")}</optgroup>`).join("");
  };
  void api<{ voices: VoiceInfo[] }>("GET", "/api/tts/voices").then((r) => {
    voices = r.voices;
    const sel = el.querySelector<HTMLSelectElement>("#char-form select[name=voice]");
    if (sel) { const cur = sel.value; sel.innerHTML = voiceOptions(); sel.value = cur; }   // 고치는 중인 설정 페이지는 칸만 채운다
    else if (!current) { rendered = ""; renderList(); }
  }).catch((err) => ctx.msg(`목소리 목록을 못 읽음: ${err}`, true));

  function show(id?: string): void {
    current = id && CHARACTERS[id] ? id : undefined;
    rendered = "";
    if (current) renderDetail(current); else renderList();
  }

  // ---------------- 목록 ----------------
  function renderList(): void {
    const cfg = ctx.config();
    if (!cfg) { el.innerHTML = `<p class="hint">설정을 읽는 중…</p>`; return; }
    const key = JSON.stringify([cfg.ribbon, cfg.characters]);
    if (key === rendered) return;
    rendered = key;
    const r = cfg.ribbon;
    const opts = (withNone: boolean) => (withNone ? `<option value="">없음 (혼자)</option>` : "")
      + Object.values(CHARACTERS).map((c) => `<option value="${c.id}">${esc(profileOf(c.id)?.name ?? c.name)}</option>`).join("");
    el.innerHTML = `
      <div class="chars">
        <section class="card">
          <h2>TV 에 나오는 캐릭터</h2>
          <div class="cols">
            <label>주인공 (아이들과 대화) <select id="main-sel">${opts(false)}</select></label>
            <label>같이 나오는 친구 (돌아다니기만) <select id="friend-sel">${opts(true)}</select></label>
          </div>
          <p class="hint">바꾸면 바로 저장되고 TV 화면이 한 번 새로 열립니다. 주인공의 이름·성격·목소리로 대화합니다.</p>
        </section>
        <div class="profile-grid">
          ${Object.values(CHARACTERS).map((c) => card(c.id)).join("")}
        </div>
        ${commonForm()}
        <section class="card">
          <h2>모든 아이와의 약속</h2>
          <div id="common-promises"></div>
          <p class="hint">어느 캐릭터가 주인공이든 모든 아이와 대화할 때 지킵니다. 아이 한 명과의 약속은 아이들 탭에서 봅니다.</p>
        </section>
      </div>`;
    const main = el.querySelector("#main-sel") as HTMLSelectElement;
    const friend = el.querySelector("#friend-sel") as HTMLSelectElement;
    main.value = characterOf(r.character).id;
    friend.value = r.friend && CHARACTERS[r.friend] ? r.friend : "";
    const saveCast = async () => {
      if (main.value === friend.value) friend.value = "";
      try {
        await api("PUT", "/api/config/ribbon", { character: main.value, friend: friend.value });
        ctx.msg(`주인공: ${profileOf(main.value)?.name ?? main.value}${friend.value ? ` · 친구: ${profileOf(friend.value)?.name}` : ""}`);
      } catch (err) { ctx.msg(String(err), true); }
    };
    main.onchange = saveCast;
    friend.onchange = saveCast;
    el.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((b) => { b.onclick = () => ctx.go(`characters/${b.dataset.edit}`); });
    el.querySelectorAll<HTMLImageElement>("img[data-shot]").forEach((img) => void fillShot(img));
    bindCommon();
    (el.querySelector("#common-promises") as HTMLElement).appendChild(commonPromisesEl);
    commonPromises.show(null);
  }

  function card(id: string): string {
    const spec = CHARACTERS[id];
    const p = profileOf(id);
    const role = roleOf(id);
    const outfit = spec.outfits.find((o) => o.id === p?.look?.outfit)?.name ?? spec.outfits[0].name;
    return `<article class="card profile ${role}">
      <img data-shot="${id}" alt="" />
      <div class="pbody">
        <div class="row"><h3>${esc(p?.name ?? spec.name)}</h3><span class="badge ${role}">${ROLE[role]}</span></div>
        <p class="intro">${esc(p?.intro || spec.name)}</p>
        <p class="persona">${esc(p?.personality || "성격이 아직 없습니다")}</p>
        <dl>
          <dt>목소리</dt><dd>${p ? `${voiceName(p.voice)} · 속도 ${p.speed} · 피치 ${p.pitch > 0 ? "+" : ""}${p.pitch}` : "-"}</dd>
          <dt>옷</dt><dd>${esc(outfit)}</dd>
        </dl>
        <button data-edit="${id}" class="primary">설정</button>
      </div>
    </article>`;
  }

  async function fillShot(img: HTMLImageElement): Promise<void> {
    const id = img.dataset.shot!;
    const look = profileOf(id)?.look;
    const key = `${id}:${JSON.stringify(look ?? {})}`;
    if (!shots.has(key)) {
      try { shots.set(key, await snapshot(id, look)); } catch { return; }
    }
    if (img.isConnected) img.src = shots.get(key)!;
  }

  function commonForm(): string {
    return `<section class="card">
      <h2>대화 · 움직임 (모든 캐릭터 공통)</h2>
      <form id="common-form" class="cols">
        <label>입력 방식 <select name="input_mode">
          <option value="button">버튼을 누른 뒤에만 듣기 (말 한 번)</option>
          <option value="auto">자동 (대답 뒤 이어 말하기 · 말로 깨우기 · 끼어들기)</option></select></label>
        <label>부르면 <select name="listen_cue">
          <option value="sound">"띵" 소리만 (아이가 바로 말할 수 있음)</option>
          <option value="voice">"응 ○○야, 말해봐." 라고 대답</option></select></label>
        <label>말이 끝났다고 보는 조용한 시간 (초, 아이가 말하다 자주 끊기면 늘리기)
          <input name="end_silence_s" type="number" step="0.1" min="0.5" max="3" /></label>
        <label>호출 버튼을 누른 뒤 기다리는 시간 (초, 이 안에 먼저 말한 아이 차례)
          <input name="button_window_s" type="number" step="1" min="2" max="20" /></label>
        <label>한 번에 최대 문장 수 (놀이 상대는 1~2) <input name="max_sentences" type="number" min="1" max="6" /></label>
        <label>첫 추임새까지 (초) <input name="filler_delay_s" type="number" step="0.5" min="0.5" max="10" /></label>
        <label>추임새 간격 (초) <input name="filler_interval_s" type="number" step="0.5" min="1" max="15" /></label>
        <label class="inline"><input name="ack_enabled" type="checkbox" /> 알아들으면 바로 짧게 반응 ("응!", "아하!")</label>
        <label class="inline"><input name="filler_enabled" type="checkbox" /> 답이 늦으면 추임새 ("음...")</label>
        <label class="inline"><input name="pokedex_enabled" type="checkbox" /> 포켓몬 이야기가 나오면 도감을 보고 답하기 (tools/fetch_pokedex.py 로 받아 둔 도감)</label>
        <label>포켓몬 맞추기에 나올 포켓몬 (도감 1번 ~ 이 번호, 151 = 1세대, 1025 = 전부)
          <input name="game_max_id" type="number" min="10" max="1025" /></label>
        <label class="inline"><input name="barge_in" type="checkbox" /> 리본이가 말하는 중에 아이가 말하면 멈추고 듣기 (끼어들기, 자동 방식일 때만)</label>
        <label>끼어들기 소리 크기 기준 (서버 로그 "리본이 목소리가 마이크에 들어온 크기" 보다 넉넉히 크게. 잘 안 멈추면 낮추기)
          <input name="barge_in_rms" type="number" step="0.005" min="0.01" max="0.5" /></label>
        <label class="inline"><input name="save_recordings" type="checkbox" /> 인식 개선용으로 아이 말 녹음 저장 (data/recordings/, tools/stt_eval.py 로 모델 비교)</label>
        <label class="inline"><input name="memory_enabled" type="checkbox" /> 아이가 지적하거나 하지 말라고 한 것을 약속으로 기억하기</label>
        <label>아이 한 명당 약속 수 (넘치면 오래된 것부터 지움) <input name="memory_max_per_kid" type="number" min="1" max="50" /></label>
        <label class="inline"><input name="wander" type="checkbox" /> 평소에 방을 돌아다니기 (끄면 "부르면 오는 자리"에 서 있음)</label>
        <label>걷는 속도 <input name="walk_speed" type="range" min="0.5" max="2" step="0.1" /> <output id="walk-out"></output></label>
        <label>대화가 끝나고 다시 돌아다니기까지 (초) <input name="return_after_s" type="number" step="1" min="0" max="120" /></label>
        <div class="actions"><button type="submit" class="primary">저장</button></div>
      </form>
    </section>`;
  }

  function bindCommon(): void {
    const f = el.querySelector("#common-form") as HTMLFormElement;
    const fld = (n: string) => f.elements.namedItem(n) as HTMLInputElement;
    const r = rc()!;
    fld("max_sentences").value = String(r.max_sentences);
    fld("listen_cue").value = r.listen_cue ?? "sound";
    fld("input_mode").value = r.input_mode ?? "button";
    fld("button_window_s").value = String(r.button_window_s ?? 6);
    fld("end_silence_s").value = String((r.end_silence_ms ?? 1300) / 1000);
    fld("filler_delay_s").value = String(r.filler_delay_s ?? 1.5);
    fld("filler_interval_s").value = String(r.filler_interval_s ?? 4);
    fld("ack_enabled").checked = r.ack_enabled ?? true;
    fld("filler_enabled").checked = r.filler_enabled ?? true;
    fld("memory_enabled").checked = r.memory_enabled ?? true;
    fld("pokedex_enabled").checked = r.pokedex_enabled ?? true;
    fld("save_recordings").checked = r.save_recordings ?? false;
    fld("barge_in").checked = r.barge_in ?? true;
    fld("barge_in_rms").value = String(r.barge_in_rms ?? 0.06);
    fld("game_max_id").value = String(r.game_max_id ?? 1025);
    fld("memory_max_per_kid").value = String(r.memory_max_per_kid ?? 20);
    fld("wander").checked = r.wander ?? true;
    fld("walk_speed").value = String(r.walk_speed ?? 1);
    fld("return_after_s").value = String(r.return_after_s ?? 8);
    const out = () => { (el.querySelector("#walk-out") as HTMLElement).textContent = `×${fld("walk_speed").value}`; };
    out();
    f.oninput = out;
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("PUT", "/api/config/ribbon", {
          max_sentences: Number(fld("max_sentences").value) || 2,
          listen_cue: fld("listen_cue").value,
          input_mode: fld("input_mode").value,
          button_window_s: Number(fld("button_window_s").value) || 6,
          end_silence_ms: Math.round((Number(fld("end_silence_s").value) || 1.3) * 1000),
          filler_delay_s: Number(fld("filler_delay_s").value) || 1.5,
          filler_interval_s: Number(fld("filler_interval_s").value) || 4,
          ack_enabled: fld("ack_enabled").checked, filler_enabled: fld("filler_enabled").checked,
          memory_enabled: fld("memory_enabled").checked,
          pokedex_enabled: fld("pokedex_enabled").checked,
          save_recordings: fld("save_recordings").checked,
          barge_in: fld("barge_in").checked,
          barge_in_rms: Number(fld("barge_in_rms").value) || 0.06,
          game_max_id: Math.max(10, Math.min(1025, Number(fld("game_max_id").value) || 1025)),
          memory_max_per_kid: Number(fld("memory_max_per_kid").value) || 20,
          wander: fld("wander").checked, walk_speed: Number(fld("walk_speed").value) || 1,
          return_after_s: Number(fld("return_after_s").value) || 0,
        });
        ctx.msg("공통 설정 저장됨");
      } catch (err) { ctx.msg(String(err), true); }
    };
  }

  // ---------------- 캐릭터 설정 (이력서) ----------------
  let preview: Ribbon3D | null = null;

  function renderDetail(id: string): void {
    const spec = CHARACTERS[id];
    const p = profileOf(id);
    if (!p) { el.innerHTML = `<p class="hint">설정을 읽는 중…</p>`; return; }
    rendered = "detail";
    const role = roleOf(id);
    el.innerHTML = `
      <div class="resume-wrap">
        <button id="back" class="link">← 캐릭터 목록</button>
        <form id="char-form" class="card resume">
          <div class="resume-head">
            <div class="resume-id">
              <span class="badge ${role}">${ROLE[role]}</span>
              <input name="name" class="big" required />
              <input name="intro" placeholder="한 줄 소개 (예: 양갈래 머리의 씩씩한 여자 친구)" />
              ${role === "main" ? "" : `<button type="button" id="make-main">이 캐릭터를 주인공으로</button>`}
            </div>
            <div class="resume-photo"><div id="char-preview"></div>
              <div class="actions"><button type="button" id="greet">👋 인사</button></div></div>
          </div>
          <section><h3>성격 · 말투</h3>
            <textarea name="personality" rows="4" placeholder="예: 밝고 호기심이 많다. 그림을 보면 색 이름을 영어로도 한 번 말해 준다."></textarea>
            <p class="hint">주인공일 때 대화 규칙 뒤에 붙습니다. 짧고 분명하게 쓰면 잘 따릅니다.</p></section>
          <section><h3>목소리</h3>
            <div class="cols">
              <label>음성 <select name="voice">${voices.length ? voiceOptions() : `<option value="${esc(p.voice)}">${esc(p.voice)}</option>`}</select></label>
              <label>속도 <input name="speed" type="range" min="0.7" max="2" step="0.05" /> <output data-out="speed"></output></label>
              <label>품질 <input name="steps" type="range" min="5" max="12" step="1" /> <output data-out="steps"></output></label>
              <label>피치 (반음. 아이 목소리 조합은 이미 어리게 바뀌어 있어 0 권장) <input name="pitch" type="range" min="-6" max="8" step="0.5" /> <output data-out="pitch"></output></label>
            </div>
            <div class="row"><input name="preview_text" class="grow" /><button type="button" id="tts">🔊 미리 듣기</button></div></section>
          <section><h3>옷</h3>
            <div class="cols">
              <label>옷 <select name="outfit">${spec.outfits.map((o) => `<option value="${o.id}">${o.name}</option>`).join("")}</select></label>
              ${Object.entries(TINT_NAME).filter(([k]) => Object.values(spec.tint).includes(k as keyof RibbonLook))
                .map(([k, n]) => `<label>${n} <input name="${k}" type="color" /></label>`).join("")}
            </div>
            ${Object.keys(spec.tint).length ? `<button type="button" id="look-reset">기본 색으로</button>` : `<p class="hint">이 캐릭터는 만들 때 정한 색을 그대로 씁니다.</p>`}
          </section>
          <div class="actions"><button type="submit" class="primary">저장</button></div>
        </form>
      </div>`;
    const f = el.querySelector("#char-form") as HTMLFormElement;
    const fld = (n: string) => f.elements.namedItem(n) as HTMLInputElement | null;
    const set = (n: string, v: string) => { const x = fld(n); if (x) x.value = v; };
    set("name", p.name); set("intro", p.intro); set("voice", p.voice);
    set("speed", String(p.speed)); set("steps", String(p.steps)); set("pitch", String(p.pitch));
    (f.elements.namedItem("personality") as HTMLTextAreaElement).value = p.personality;
    set("preview_text", `안녕, 나는 ${p.name}이야. 오늘은 무슨 그림을 그렸어?`);
    const look = { ...DEFAULT_LOOK, ...p.look };
    set("outfit", spec.outfits.some((o) => o.id === look.outfit) ? look.outfit : spec.outfits[0].id);
    for (const k of Object.keys(TINT_NAME)) set(k, String(look[k as keyof RibbonLook]));

    preview = mountPreview(el.querySelector("#char-preview") as HTMLElement, id, 220, 280);
    const lookNow = (): RibbonLook => ({
      outfit: fld("outfit")!.value,
      hair: fld("hair")?.value ?? look.hair, bow: fld("bow")?.value ?? look.bow,
      dress: fld("dress")?.value ?? look.dress, blouse: fld("blouse")?.value ?? look.blouse,
    });
    const outs = () => {
      for (const n of ["speed", "steps", "pitch"]) (f.querySelector(`[data-out=${n}]`) as HTMLElement).textContent = fld(n)!.value;
    };
    void preview.loaded.then(() => preview?.setLook(lookNow()));
    outs();
    f.oninput = () => { outs(); preview?.setLook(lookNow()); };
    fld("voice")!.onchange = () => {   // "천천히" 조합은 속도도 같이 맞춘다
      const sp = voiceOf(fld("voice")!.value)?.speed;
      if (sp) { set("speed", String(sp)); outs(); }
    };

    (el.querySelector("#back") as HTMLButtonElement).onclick = () => ctx.go("characters");
    (el.querySelector("#greet") as HTMLButtonElement).onclick = () => preview?.greet();
    const reset = el.querySelector("#look-reset") as HTMLButtonElement | null;
    if (reset) reset.onclick = () => { for (const k of Object.keys(TINT_NAME)) set(k, String(DEFAULT_LOOK[k as keyof RibbonLook])); preview?.setLook(lookNow()); };
    const mk = el.querySelector("#make-main") as HTMLButtonElement | null;
    if (mk) mk.onclick = async () => {
      try {
        const r = rc();
        await api("PUT", "/api/config/ribbon", { character: id, friend: r?.friend === id ? "" : r?.friend ?? "" });
        ctx.msg(`${p.name}이(가) 주인공이 되었습니다`);
      } catch (err) { ctx.msg(String(err), true); }
    };
    (el.querySelector("#tts") as HTMLButtonElement).onclick = async () => {
      ctx.msg("합성 중...");
      try {
        const blob = await api<Blob>("POST", "/api/tts/preview", {
          text: fld("preview_text")!.value, voice: fld("voice")!.value,
          speed: Number(fld("speed")!.value), steps: Number(fld("steps")!.value), pitch: Number(fld("pitch")!.value),
        });
        const audio = new Audio(URL.createObjectURL(blob));
        const talk = window.setInterval(() => preview?.setMouthLevel(0.3 + Math.random() * 0.7), 120);
        const done = () => { clearInterval(talk); preview?.setMouthLevel(0); preview?.setState("idle"); };
        preview?.setState("speaking");
        audio.onended = done;
        await audio.play().catch((err) => { done(); throw err; });
        ctx.msg(`${voiceName(fld("voice")!.value)} 재생 중`);
      } catch (err) { ctx.msg(String(err), true); preview?.setState("idle"); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const saved = await api<CharacterProfile>("PUT", `/api/config/character/${id}`, {
          name: fld("name")!.value.trim() || spec.name, intro: fld("intro")!.value.trim(),
          personality: (f.elements.namedItem("personality") as HTMLTextAreaElement).value.trim(),
          voice: fld("voice")!.value, speed: Number(fld("speed")!.value), steps: Number(fld("steps")!.value),
          pitch: Number(fld("pitch")!.value) || 0, look: lookNow(),
        });
        ctx.msg(`${saved.name} 저장됨${roleOf(id) === "main" ? " (지금 대화에 바로 쓰입니다)" : ""}`);
      } catch (err) { ctx.msg(String(err), true); }
    };
  }

  ctx.onState(() => {
    // 설정 페이지는 고치는 중일 수 있어 다시 그리지 않는다 (주인공이 바뀐 경우만 역할 표시를 위해 다시)
    if (current) {
      if (!el.querySelector("#char-form")) { renderDetail(current); return; }   // 주소로 바로 열어 설정이 늦게 온 경우
      const badge = el.querySelector(".resume .badge");
      const role = roleOf(current);
      if (badge && badge.textContent !== ROLE[role]) renderDetail(current);
      return;
    }
    renderList();
  });
  return { show };
}
