import { MicAgent } from "../audio/micAgent";
import type { KidInfo, ServerMsg } from "../protocol";
import type { RibbonSocket } from "../ws";

const STATE_LABEL: Record<string, string> = { idle: "기다리는 중", listening: "👂 듣는 중", thinking: "💭 생각 중", speaking: "🗣 말하는 중" };

/**
 * 마이크 화면 (?mode=mic). 무선 마이크 수신기가 꽂힌 컴퓨터(보통 맥미니)에서 켜 둔다.
 * 장치 고르기·켜기·끄기는 관리자 '설정' 탭에서 한다 (MicAgent 가 이 화면에서 실제로 마이크를 연다).
 * 여기는 상태만 보여 준다: 켜짐, 채널별 음량, 리본이 상태, 인식된 말.
 */
export async function startMic(socket: RibbonSocket): Promise<void> {
  document.title = "리본 마이크";
  const root = document.getElementById("app")!;
  root.innerHTML = `
    <div id="mic-page">
      <h1>🎙 리본 마이크</h1>
      <p class="hint">이 창을 켜 두면 마이크 소리가 리본 서버로 갑니다. 창을 닫으면 리본이가 듣지 못합니다.<br>
        장치 고르기·켜기·끄기는 <b>관리자 페이지 → 설정</b>에서 합니다.</p>
      <div id="mic-lock" class="mic-lock" hidden>🔒 이 화면을 한 번 클릭하세요 (브라우저가 소리 입력을 막고 있습니다)</div>
      <div class="mic-status">
        <div>마이크: <b id="mic-on" class="mic-state">꺼짐</b></div>
        <div id="mic-msg" class="mic-msg"></div>
      </div>
      <div class="mic-vu">${[0, 1, 2, 3].map((c) => `<div><div class="bar"><i data-ch="${c}"></i></div><span data-name="${c}">마이크 ${c + 1}</span></div>`).join("")}</div>
      <div class="mic-status">
        <div>리본이: <b id="mic-ribbon">-</b></div>
        <div id="mic-heard" class="hint"></div>
      </div>
      <p class="hint"><a href="/?mode=admin#settings" style="color:#ffd54a">관리자 설정 열기</a></p>
    </div>`;
  const $ = (id: string) => document.getElementById(id)!;
  const agent = new MicAgent(socket, { autoStart: true });
  const show = () => {
    const on = agent.running;
    $("mic-on").textContent = on ? `켜짐 · ${agent.capture.opened.map((o) => `${o.label} (${o.channelCount}ch)`).join(", ")}` : "꺼짐";
    $("mic-on").classList.toggle("on", on);
    $("mic-msg").textContent = agent.msg;
    $("mic-lock").hidden = !agent.locked;
  };
  agent.onChange = show;
  show();
  setInterval(() => {
    for (const bar of document.querySelectorAll<HTMLElement>(".mic-vu i")) {
      bar.style.height = `${Math.min(100, Math.round(agent.capture.levels[Number(bar.dataset.ch)] * 400))}%`;
    }
  }, 80);

  let kids: KidInfo[] = [];
  socket.on((m: ServerMsg) => {
    if (m.type === "state") {
      kids = m.kids;
      document.querySelectorAll<HTMLElement>("[data-name]").forEach((el) => {
        const c = Number(el.dataset.name);
        el.textContent = `${c + 1} ${kids.find((k) => k.mic_channel === c)?.name ?? "-"}`;
      });
    }
    if (m.type === "state" || m.type === "ribbon.state") {
      const s = m.type === "state" ? m.ribbon : m.state;
      $("mic-ribbon").textContent = STATE_LABEL[s] ?? s;
    }
    if (m.type === "transcript") {
      const name = kids.find((k) => k.id === m.kid_id)?.name ?? `마이크 ${m.channel + 1}`;
      $("mic-heard").textContent = `${new Date().toLocaleTimeString()}  ${name}: ${m.text}`;
    }
  });
}
