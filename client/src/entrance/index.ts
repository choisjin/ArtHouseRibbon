import type { KidInfo, ServerMsg } from "../protocol";
import { Speaker } from "../speech/browserTts";
import type { RibbonSocket } from "../ws";

/**
 * 출입구 폰 (3단계 골격).
 * 지금은 카메라 미리보기와 아이 이름 버튼으로 등원을 흉내 낸다.
 * 얼굴 식별이 붙으면 버튼 대신 서버가 알아본 아이로 kid.enter 를 보낸다.
 * 인사말은 이 폰의 스피커로만 읽는다 (TV 가 아니라 문 앞에서 들려야 하므로).
 */
export async function startEntrance(socket: RibbonSocket): Promise<void> {
  const root = document.getElementById("app")!;
  root.innerHTML = `
    <div id="mode">
      <div>
        <h2>리본 출입구</h2>
        <video id="cam" autoplay playsinline muted></video>
        <p style="color:#aaa">얼굴 인식은 3단계에서 연결됩니다. 지금은 이름을 눌러 등원을 흉내 냅니다.</p>
        <div id="kids" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"></div>
        <p id="msg" style="font-size:22px;min-height:1.5em"></p>
      </div>
    </div>`;
  const video = document.getElementById("cam") as HTMLVideoElement;
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 640 }, audio: false });
  } catch (e) { console.warn("camera unavailable", e); }

  const speaker = new Speaker(socket);
  let lastEnterAt = 0;
  const msg = document.getElementById("msg")!;
  speaker.onStart = (m) => { msg.textContent = m.text; };

  const renderKids = (kids: KidInfo[]) => {
    const box = document.getElementById("kids")!;
    box.innerHTML = "";
    for (const k of kids) {
      const b = document.createElement("button");
      b.textContent = k.present ? `${k.name} (하원)` : k.name;
      b.style.cssText = "padding:14px 18px;font-size:18px;border-radius:12px;border:1px solid #666;background:#1b1626;color:#eee";
      b.onclick = () => { lastEnterAt = performance.now(); socket.sendJson({ type: k.present ? "kid.leave" : "kid.enter", kid_id: k.id }); };
      box.appendChild(b);
    }
  };

  socket.on((m: ServerMsg) => {
    if (m.type === "state") renderKids(m.kids);
    if (m.type === "speak" && performance.now() - lastEnterAt < 5000) speaker.enqueue(m);
  });
}
