import { Mic, type MicChoice } from "../audio/mic";
import type { RibbonSocket } from "../ws";
import { keepAwake } from "../util/wakelock";

/**
 * 마이크 전용 화면 (?mode=mic). **무선 마이크 수신기를 꽂아 둘 기기**에서 이것만 열어 두면 된다.
 *
 * 폰 한 대로 TV 화면과 마이크를 같이 쓰지 못하는 기종이 있어서(USB 를 꽂으면 소리 출력까지 USB 로 간다)
 * 기기를 나눠 쓴다: 한 대는 TV 화면, 다른 한 대는 이 화면 + 수신기.
 * 관리자 페이지에서도 같은 일을 할 수 있지만(설정 → 마이크), 이 화면은 그것만 해서 가볍고 잘못 누를 것이 없다.
 *
 * - 고른 장치는 이 브라우저가 기억해서 다음에 열면 바로 켠다
 * - 화면이 꺼지면 소리가 끊기므로 화면 꺼짐을 막는다 (https 에서)
 */
const SETS = [{ offset: 0, name: "1세트 (마이크 1·2)" }, { offset: 2, name: "2세트 (마이크 3·4)" }];

export function startMicPage(socket: RibbonSocket): void {
  document.body.innerHTML = PAGE;
  const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
  const mic = new Mic(socket, { autoStart: true });
  void keepAwake();

  function render(): void {
    const state = !mic.running ? `<span class="pill">꺼짐</span>`
      : mic.locked ? `<span class="pill warn">화면을 한 번 누르세요</span>`
        : `<span class="pill ok">듣는 중</span>`;
    $("#state").innerHTML = state;
    $("#msg").textContent = mic.msg;

    if (!mic.listed) {
      $("#body").innerHTML = `<p class="hint">이 기기에 꽂은 마이크를 찾습니다. 브라우저가 마이크 권한을 물어보면 허용해 주세요.</p>
        <button class="big" data-act="find">마이크 장치 찾기</button>`;
      $<HTMLButtonElement>("[data-act=find]").onclick = () => void mic.refresh();
      return;
    }
    const sel = (offset: number): string => {
      const cur = mic.selected.find((x) => x.channelOffset === offset)?.deviceId ?? "";
      return `<label>${SETS.find((s) => s.offset === offset)!.name}
        <select data-offset="${offset}"><option value="">(사용 안 함)</option>${mic.devices.map((d) =>
        `<option value="${d.deviceId}" ${d.deviceId === cur ? "selected" : ""}>${d.label}</option>`).join("")}</select></label>`;
    };
    $("#body").innerHTML = `${sel(0)}${sel(2)}
      <button class="big ${mic.running ? "off" : ""}" data-act="toggle">${mic.running ? "마이크 끄기" : "마이크 켜기"}</button>
      <button class="big sub" data-act="refresh">장치 다시 찾기</button>
      <div class="vu">${[0, 1, 2, 3].map((c) => `<div><i data-ch="${c}"></i></div>`).join("")}</div>`;

    const choice = (): MicChoice[] => [...document.querySelectorAll<HTMLSelectElement>("#body select")]
      .filter((x) => x.value)
      .map((x) => ({ deviceId: x.value, label: x.selectedOptions[0]?.textContent ?? "", channelOffset: Number(x.dataset.offset) }));
    document.querySelectorAll<HTMLSelectElement>("#body select").forEach((x) => {
      x.onchange = () => { if (mic.running) void mic.start(choice()); else mic.selected = choice(); };
    });
    $<HTMLButtonElement>("[data-act=toggle]").onclick = () => {
      if (mic.running) { void mic.stop(); return; }
      const list = choice();
      if (!list.length) { $("#msg").textContent = "마이크 장치를 먼저 고르세요"; return; }
      void mic.start(list);
    };
    $<HTMLButtonElement>("[data-act=refresh]").onclick = () => void mic.refresh();
  }
  mic.onChange = render;
  render();

  // 음량 막대
  setInterval(() => {
    document.querySelectorAll<HTMLElement>(".vu i").forEach((bar) => {
      bar.style.height = `${Math.round(mic.level(Number(bar.dataset.ch)) * 100)}%`;
    });
  }, 80);
}

const PAGE = `
<style>
  html { background: #f6f3fa; }
  body { margin: 0; min-height: 100vh; background: #f6f3fa; color: #221c2e; font-family: system-ui, -apple-system, sans-serif;
    padding: 20px; padding-bottom: max(20px, env(safe-area-inset-bottom)); }
  .wrap { max-width: 460px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
  p.sub { color: #7a7289; font-size: 13px; margin: 0 0 18px; line-height: 1.5; }
  label { display: block; font-size: 13px; color: #4d4560; margin-bottom: 12px; }
  select { width: 100%; padding: 12px; font: inherit; margin-top: 4px; border-radius: 12px; border: 1px solid #cfc6dc; background: #fff; }
  .big { display: block; width: 100%; padding: 16px; font: inherit; font-size: 17px; font-weight: 700; color: #fff;
    background: #7b4bd8; border: none; border-radius: 14px; margin-bottom: 10px; }
  .big.off { background: #e03131; }
  .big.sub { background: #fff; color: #4d4560; border: 1px solid #cfc6dc; font-weight: 600; }
  .pill { font-size: 12px; padding: 4px 10px; border-radius: 99px; border: 1px solid #cfc6dc; color: #7a7289; }
  .pill.ok { color: #2e9e55; border-color: #2e9e55; font-weight: 700; }
  .pill.warn { color: #fff; background: #d9861a; border-color: #d9861a; font-weight: 700; }
  .hint { font-size: 13px; color: #7a7289; line-height: 1.5; }
  #msg { min-height: 20px; font-size: 13px; color: #d8453a; margin: 8px 0 0; }
  .vu { display: flex; gap: 8px; height: 60px; margin-top: 12px; }
  .vu div { flex: 1; background: #ece6f8; border-radius: 8px; display: flex; align-items: flex-end; overflow: hidden; }
  .vu i { display: block; width: 100%; height: 0; background: #7b4bd8; transition: height .08s; }
  a { color: #7b4bd8; font-size: 13px; }
</style>
<div class="wrap">
  <h1>🎙 리본 마이크 <span id="state"></span></h1>
  <p class="sub">무선 마이크 수신기를 꽂은 기기에서 이 화면을 열어 두세요. 이 창을 닫거나 화면이 꺼지면 리본이가 듣지 못합니다.
    소리는 다른 기기(TV 화면)에서 납니다.</p>
  <div id="body"></div>
  <p id="msg"></p>
  <p><a href="/?mode=admin">관리자 페이지로</a></p>
</div>`;
