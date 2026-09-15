import { AudioCapture } from "../audio/capture";
import type { KidInfo } from "../protocol";
import type { RibbonSocket } from "../ws";

/**
 * 디버그 패널 (키보드 d 로 토글).
 * 마이크와 모델 없이도 호출/발화/취소/등원을 흉내 내 대기열 흐름을 확인한다.
 * '마이크 시작' 은 실제 장치를 열어 채널별 PCM 을 서버로 보낸다.
 */
export function mountDebugPanel(socket: RibbonSocket, getKids: () => KidInfo[]): void {
  const root = document.getElementById("debug")!;
  root.style.display = "block";
  root.innerHTML = `
    <b>리본 디버그</b>
    <label>채널 (아이)</label>
    <select id="dbg-ch"></select>
    <label>말할 내용</label>
    <input id="dbg-text" placeholder="리본아 내 그림 봐줘" />
    <button id="dbg-wake">호출 (리본아)</button>
    <button id="dbg-say">말하기</button>
    <button id="dbg-cancel">내 말 취소</button>
    <button id="dbg-enter">등원</button>
    <button id="dbg-leave">하원</button>
    <label>마이크 장치 (최대 2개, 순서대로 채널 0-1, 2-3)</label>
    <select id="dbg-dev1"></select>
    <select id="dbg-dev2"></select>
    <button id="dbg-mic">마이크 시작</button>
    <div class="log" id="dbg-log"></div>
  `;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const chSel = $<HTMLSelectElement>("dbg-ch");
  const text = $<HTMLInputElement>("dbg-text");
  const log = $<HTMLDivElement>("dbg-log");
  const dev1 = $<HTMLSelectElement>("dbg-dev1");
  const dev2 = $<HTMLSelectElement>("dbg-dev2");
  const capture = new AudioCapture(socket);

  let lastKidsKey = "";
  const refreshKids = () => {
    const kids = getKids();
    const key = kids.map((k) => `${k.id}:${k.mic_channel}`).join(",");
    if (key === lastKidsKey) return; // 다시 그리면 선택이 초기화되므로 바뀐 경우에만
    lastKidsKey = key;
    const prev = chSel.value;
    chSel.innerHTML = "";
    for (let ch = 0; ch < 4; ch++) {
      const kid = kids.find((k) => k.mic_channel === ch);
      const o = document.createElement("option");
      o.value = String(ch);
      o.textContent = `${ch}: ${kid?.name ?? "(미배정)"}`;
      chSel.appendChild(o);
    }
    if (prev) chSel.value = prev;
  };
  setTimeout(refreshKids, 500);
  setInterval(refreshKids, 5000);

  const ch = () => Number(chSel.value);
  const kidOf = () => getKids().find((k) => k.mic_channel === ch());
  const send = (obj: unknown) => { socket.sendJson(obj); append("→ " + JSON.stringify(obj)); };
  const append = (s: string) => { log.textContent = (s + "\n" + log.textContent).slice(0, 4000); };

  $("dbg-wake").onclick = () => send({ type: "debug.wake", channel: ch() });
  $("dbg-say").onclick = () => { if (text.value.trim()) { send({ type: "debug.utterance", channel: ch(), text: text.value }); text.value = ""; } };
  text.onkeydown = (e) => { if (e.key === "Enter") $("dbg-say").click(); };
  $("dbg-cancel").onclick = () => send({ type: "debug.utterance", channel: ch(), text: "내 말 취소" });
  $("dbg-enter").onclick = () => { const k = kidOf(); if (k) send({ type: "kid.enter", kid_id: k.id }); };
  $("dbg-leave").onclick = () => { const k = kidOf(); if (k) send({ type: "kid.leave", kid_id: k.id }); };

  void AudioCapture.listInputs().then((devs) => {
    for (const sel of [dev1, dev2]) {
      sel.innerHTML = `<option value="">(사용 안 함)</option>`;
      for (const d of devs) {
        const o = document.createElement("option");
        o.value = d.deviceId; o.textContent = d.label || d.deviceId.slice(0, 8);
        sel.appendChild(o);
      }
    }
  });
  $("dbg-mic").onclick = async () => {
    if (capture.running) { await capture.stop(); $("dbg-mic").textContent = "마이크 시작"; return; }
    const devices = [dev1.value && { deviceId: dev1.value, channelOffset: 0 }, dev2.value && { deviceId: dev2.value, channelOffset: 2 }]
      .filter(Boolean) as { deviceId: string; channelOffset: number }[];
    if (!devices.length) { append("마이크 장치를 고르세요"); return; }
    await capture.start(devices);
    $("dbg-mic").textContent = "마이크 중지";
    append("마이크 전송 중: " + devices.map((d) => d.channelOffset).join(","));
  };

  socket.on((m) => append("← " + JSON.stringify(m).slice(0, 300)));
  window.addEventListener("keydown", (e) => { if (e.key === "d" && document.activeElement !== text) root.style.display = root.style.display === "none" ? "block" : "none"; });
}
