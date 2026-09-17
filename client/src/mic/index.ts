import { mountMicControl } from "../audio/micControl";
import type { KidInfo, ServerMsg } from "../protocol";
import type { RibbonSocket } from "../ws";

const STATE_LABEL: Record<string, string> = { idle: "기다리는 중", listening: "👂 듣는 중", thinking: "💭 생각 중", speaking: "🗣 말하는 중" };

/**
 * 마이크 화면 (?mode=mic). 무선 마이크 수신기가 꽂힌 컴퓨터(보통 맥미니)에서 켜 둔다.
 * 고른 장치를 기억해 두었다가 열자마자 마이크를 켜고, 채널별 음량과 리본이 상태·인식된 말을 보여준다.
 */
export async function startMic(socket: RibbonSocket): Promise<void> {
  document.title = "리본 마이크";
  const root = document.getElementById("app")!;
  root.innerHTML = `
    <div id="mic-page">
      <h1>🎙 리본 마이크</h1>
      <p class="hint">이 창을 켜 두면 마이크 소리가 리본 서버로 갑니다. 창을 닫거나 탭을 닫으면 리본이가 듣지 못합니다.</p>
      <div id="mic-box"></div>
      <div class="mic-status">
        <div>리본이: <b id="mic-ribbon">-</b></div>
        <div id="mic-kids"></div>
        <div id="mic-heard" class="hint"></div>
      </div>
    </div>`;
  mountMicControl(document.getElementById("mic-box")!, socket, { autoStart: true });
  const kidsEl = document.getElementById("mic-kids")!;
  const heard = document.getElementById("mic-heard")!;
  let kids: KidInfo[] = [];
  socket.on((m: ServerMsg) => {
    if (m.type === "state") {
      kids = m.kids;
      kidsEl.textContent = [0, 1, 2, 3].map((c) => `ch${c}: ${kids.find((k) => k.mic_channel === c)?.name ?? "-"}`).join("   ");
    }
    if (m.type === "state" || m.type === "ribbon.state") {
      const s = m.type === "state" ? m.ribbon : m.state;
      document.getElementById("mic-ribbon")!.textContent = STATE_LABEL[s] ?? s;
    }
    if (m.type === "transcript") {
      const name = kids.find((k) => k.id === m.kid_id)?.name ?? `ch${m.channel}`;
      heard.textContent = `${new Date().toLocaleTimeString()}  ${name}: ${m.text}`;
    }
  });
}
