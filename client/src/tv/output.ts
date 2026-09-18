import type { DeviceRef, ServerMsg } from "../protocol";
import type { Speaker } from "../speech/browserTts";
import type { RibbonSocket } from "../ws";

/**
 * TV 소리 출력 에이전트. 출력 장치는 관리자 '설정' 탭에서 고른다 (예전 o 키 창 대신).
 * 시스템 기본 출력이 가상 장치(원격 접속 프로그램 등)로 잡혀 있어도 TV 페이지 소리만 실제 스피커/HDMI 로
 * 보낼 수 있다. Chrome 110 이상 (AudioContext.setSinkId). 고른 장치는 이 브라우저에 기억된다 (Speaker.setOutput).
 * 장치 이름은 이 컴퓨터에서 마이크 권한을 한 번 받아야 보인다 (관리자 화면의 "장치 이름 보기").
 */
export function startOutputAgent(speaker: Speaker, socket: RibbonSocket): void {
  let msg = "";

  async function report(): Promise<void> {
    const outs = await listOutputs();
    const devices: DeviceRef[] = outs.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications")
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `출력 장치 ${i + 1}` }));
    socket.sendJson({
      type: "device.status", kind: "output",
      supported: speaker.canChooseOutput, locked: !speaker.unlocked, current: speaker.outputId, devices, msg,
    });
  }

  socket.on((m: ServerMsg) => {
    if (m.type === "state") void report();                 // (다시) 연결되면 알린다
    if (m.type !== "device.control" || m.kind !== "output") return;
    void (async () => {
      try {
        if (m.action === "set") { await speaker.setOutput(m.deviceId); msg = ""; }
        else if (m.action === "beep") { await speaker.beep(); msg = speaker.unlocked ? "" : "소리가 잠겨 있어 들리지 않을 수 있습니다"; }
        else if (m.action === "labels") {
          (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
          msg = "";
        }
      } catch (e) { msg = `실패: ${e}`; }
      await report();
    })();
  });
  navigator.mediaDevices?.addEventListener?.("devicechange", () => void report());
  // 기억해 둔 출력 장치로 돌아가는 데(Speaker.restoreOutput) 잠깐 걸린다. 소리 잠금이 풀리는 것도 알린다
  setTimeout(() => void report(), 1500);
  let wasUnlocked = speaker.unlocked;
  setInterval(() => { if (speaker.unlocked !== wasUnlocked) { wasUnlocked = speaker.unlocked; void report(); } }, 1000);
}

async function listOutputs(): Promise<MediaDeviceInfo[]> {
  try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput"); }
  catch { return []; }
}
