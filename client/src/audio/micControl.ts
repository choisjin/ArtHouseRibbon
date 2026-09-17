import type { RibbonSocket } from "../ws";
import { AudioCapture, type CaptureDevice } from "./capture";

const STORE_KEY = "ribbon.mic.devices";

/** 고른 마이크 장치 (장치 id 는 브라우저·기기마다 달라서 이름도 같이 기억) */
interface SavedDevice { deviceId: string; label: string; channelOffset: number }

function loadSaved(): SavedDevice[] {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as SavedDevice[]; } catch { return []; }
}
function save(list: SavedDevice[]): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch { /* 저장소 없음 */ }
}

/**
 * 마이크 켜기/끄기 + 장치 선택 + 채널별 음량 막대. 마이크 화면(?mode=mic)과 TV(?mic=1)가 같이 쓴다.
 * 고른 장치는 이 브라우저에 기억해 두고, 다음에 열면 자동으로 켠다.
 * 브라우저가 소리 처리를 잠가 두면(클릭 전) 화면을 한 번 누르라고 안내한다.
 */
export function mountMicControl(el: HTMLElement, socket: RibbonSocket, opts: { autoStart: boolean; compact?: boolean }): AudioCapture {
  const capture = new AudioCapture(socket);
  el.innerHTML = `
    <div class="mic-row"><b>🎙 마이크</b> <span class="mic-state">꺼짐</span></div>
    <label>1세트 (채널 0·1) <select class="mic-dev" data-offset="0"></select></label>
    <label>2세트 (채널 2·3) <select class="mic-dev" data-offset="2"></select></label>
    <button class="mic-toggle">마이크 켜기</button>
    <div class="mic-vu">${[0, 1, 2, 3].map((c) => `<div><div class="bar"><i data-ch="${c}"></i></div>ch${c}</div>`).join("")}</div>
    <div class="mic-msg"></div>`;
  el.classList.add("mic-control");
  if (opts.compact) el.classList.add("compact");
  const $ = <T extends Element>(sel: string) => el.querySelector(sel) as T;
  const sels = [...el.querySelectorAll<HTMLSelectElement>(".mic-dev")];
  const state = $<HTMLSpanElement>(".mic-state");
  const btn = $<HTMLButtonElement>(".mic-toggle");
  const msg = (t: string) => { $<HTMLDivElement>(".mic-msg").textContent = t; };

  function chosen(): SavedDevice[] {
    const out: SavedDevice[] = [];
    for (const s of sels) {
      if (!s.value) continue;
      if (out.some((d) => d.deviceId === s.value)) continue;   // 같은 장치를 두 번 고르면 하나만
      out.push({ deviceId: s.value, label: s.selectedOptions[0]?.textContent ?? "", channelOffset: Number(s.dataset.offset) });
    }
    return out;
  }

  function show(): void {
    const on = capture.running;
    btn.textContent = on ? "마이크 끄기" : "마이크 켜기";
    state.textContent = on ? `켜짐 · ${capture.opened.map((o) => `${o.label} (${o.channelCount}ch)`).join(", ")}` : "꺼짐";
    state.classList.toggle("on", on);
    el.classList.toggle("running", on);
  }

  async function start(list: SavedDevice[]): Promise<void> {
    if (!list.length) { msg("마이크 장치를 고르세요"); return; }
    try {
      await capture.start(list.map((d): CaptureDevice => ({ deviceId: d.deviceId, channelOffset: d.channelOffset })));
    } catch (e) {
      msg(`마이크 열기 실패: ${e}`);
      show();
      return;
    }
    save(list);
    msg("");
    show();
    await ensureRunning();
  }

  /** 소리 처리가 잠겨 있으면 클릭 한 번으로 푼다 */
  async function ensureRunning(): Promise<void> {
    const ctx = capture.context;
    const running = () => (ctx?.state as string) === "running";
    if (!ctx || running()) return;
    try { await ctx.resume(); } catch { /* 사용자 동작 전 */ }
    if (running()) return;
    msg("⚠ 브라우저가 소리 입력을 막고 있습니다. 화면을 한 번 클릭하세요");
    const unlock = async () => {
      await capture.context?.resume();
      if (capture.context?.state === "running") {
        msg("");
        window.removeEventListener("pointerdown", unlock);
        window.removeEventListener("keydown", unlock);
      }
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
  }

  btn.onclick = async () => {
    if (capture.running) { await capture.stop(); save([]); show(); return; }
    await start(chosen());
  };

  capture.onInfo = (offset, channels) => {
    if (channels === 1) msg(`⚠ 채널 ${offset}-${offset + 1} 장치가 모노입니다. 두 사람이 한 채널로 잡힙니다`);
  };

  void AudioCapture.listInputs().then(async (devs) => {
    const saved = loadSaved();
    for (const s of sels) {
      s.innerHTML = `<option value="">(사용 안 함)</option>`;
      for (const d of devs) {
        const o = document.createElement("option");
        o.value = d.deviceId;
        o.textContent = d.label || d.deviceId.slice(0, 8);
        s.appendChild(o);
      }
      const want = saved.find((x) => x.channelOffset === Number(s.dataset.offset));
      // id 가 바뀌었으면 이름으로 찾는다
      const hit = want && (devs.find((d) => d.deviceId === want.deviceId) ?? devs.find((d) => d.label === want.label));
      s.value = hit ? hit.deviceId : "";
    }
    if (!devs.length) msg("마이크 장치가 없습니다 (권한을 허용했는지 확인)");
    if (opts.autoStart && chosen().length) await start(chosen());
  });

  setInterval(() => {
    for (const bar of el.querySelectorAll<HTMLElement>(".mic-vu i")) {
      const c = Number(bar.dataset.ch);
      bar.style.height = `${Math.min(100, Math.round(capture.levels[c] * 400))}%`;
      capture.levels[c] *= 0.9;
    }
  }, 80);
  show();
  return capture;
}
