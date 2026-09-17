import type { Speaker } from "../speech/browserTts";

/**
 * TV 소리 출력 장치 고르기 (o 키). 시스템 기본 출력이 가상 장치(원격 접속 프로그램 등)로 잡혀 있어도
 * TV 페이지 소리만 실제 스피커/HDMI 로 보낼 수 있다. Chrome 110 이상 (AudioContext.setSinkId).
 * 장치 이름은 마이크 권한을 한 번 받아야 보인다 ("장치 이름 보기").
 */
export function mountOutputPicker(speaker: Speaker): void {
  const box = document.createElement("div");
  box.className = "overlay";
  box.style.cssText = "right:16px;top:16px;width:320px;background:rgba(0,0,0,.8);border:1px solid #555;border-radius:12px;padding:12px;display:none;flex-direction:column;gap:8px";
  box.innerHTML = `
    <b>🔈 소리 출력 장치 <small style="color:#888">(o 키로 닫기)</small></b>
    <select style="padding:7px;background:#1b1626;color:#eee;border:1px solid #555;border-radius:6px"></select>
    <button data-act="labels" style="padding:7px;border-radius:6px;cursor:pointer">장치 이름 보기 (마이크 권한 요청)</button>
    <button data-act="test" style="padding:7px;border-radius:6px;cursor:pointer">🔊 삐 소리 시험</button>
    <div data-msg style="color:#ffd54a;font-size:13px"></div>`;
  document.body.appendChild(box);
  const sel = box.querySelector("select")!;
  const msg = (t: string) => { (box.querySelector("[data-msg]") as HTMLElement).textContent = t; };

  async function fill(): Promise<void> {
    const outs = await listOutputs();
    sel.innerHTML = "";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "시스템 기본 출력";
    sel.appendChild(def);
    outs.filter((d) => d.deviceId !== "default").forEach((d, i) => {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `출력 장치 ${i + 1}`;
      sel.appendChild(o);
    });
    sel.value = speaker.outputId;
    if (!speaker.canChooseOutput) msg("이 브라우저는 출력 장치 선택을 지원하지 않습니다 (Chrome 110 이상)");
  }

  sel.onchange = async () => {
    try {
      await speaker.setOutput(sel.value);
      msg(`출력: ${sel.selectedOptions[0]?.textContent}`);
    } catch (e) { msg(`바꾸지 못함: ${e}`); }
  };
  (box.querySelector('[data-act="labels"]') as HTMLButtonElement).onclick = async () => {
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); }
    catch (e) { msg(`권한 거부: ${e}`); }
    await fill();
  };
  (box.querySelector('[data-act="test"]') as HTMLButtonElement).onclick = () => { void speaker.beep(); };
  window.addEventListener("keydown", (e) => {
    if (e.key !== "o") return;
    const open = box.style.display === "none";
    box.style.display = open ? "flex" : "none";
    if (open) void fill();
  });
}

async function listOutputs(): Promise<MediaDeviceInfo[]> {
  try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput"); }
  catch { return []; }
}
