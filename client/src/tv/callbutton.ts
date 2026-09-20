import type { ServerMsg } from "../protocol";
import type { RibbonSocket } from "../ws";

/**
 * TV 화면에서 리본이 부르기 (?mode=tv) — **오른쪽 기둥에 붙은 전등 스위치**처럼 보이게 둔다.
 *
 * 폰으로 TV 를 띄우면 DJI 송신기 버튼을 쓸 수 없다 — 수신기는 USB 로 "볼륨 올림" 키를 보내는데,
 * 맥미니에서는 서버가 그 장치를 독점으로 열어 가로채지만(audio/button.py) 폰의 웹페이지는 USB 장치를 잡지 못한다.
 * 그래서 화면의 스위치를 누르거나, 블루투스 리모컨·키보드의 엔터/스페이스/미디어 키로도 부를 수 있다.
 * 서버는 이것을 호출 버튼과 똑같이 다룬다 (tv.call -> _on_button).
 *
 * 스위치의 작은 불(LED)은 **말을 받을 수 있는 동안** 켜진다 (서버 mic 메시지).
 */
const KEYS = new Set([" ", "Enter", "MediaPlayPause", "MediaPlay", "AudioPlay"]);

export function mountCallButton(socket: RibbonSocket): void {
  const btn = document.createElement("button");
  btn.id = "call-btn";
  btn.className = "overlay";
  btn.title = "리본이 부르기";
  btn.innerHTML = `
    <span class="sw-plate"><span class="sw-rocker"><i class="sw-led"></i></span></span>
    <span class="sw-label">리본아</span>`;
  document.body.appendChild(btn);

  let last = 0;
  const call = (): void => {
    const now = performance.now();
    if (now - last < 1500) return;                 // 아이들이 연달아 누르는 것은 한 번으로
    last = now;
    socket.sendJson({ type: "tv.call" });
    btn.classList.add("pressed");
    setTimeout(() => btn.classList.remove("pressed"), 700);
  };
  btn.onclick = call;
  window.addEventListener("keydown", (ev) => {
    if (KEYS.has(ev.key) && !(ev.target instanceof HTMLInputElement)) {
      ev.preventDefault();
      call();
    }
  });
  // 말을 받는 동안 스위치 불이 켜진다 (오른쪽 위 마이크 표시와 같은 신호)
  socket.on((m: ServerMsg) => { if (m.type === "mic") btn.classList.toggle("listening", m.on); });
}
