import type { RibbonSocket } from "../ws";

/**
 * TV 화면에서 리본이 부르기 (?mode=tv).
 *
 * 폰으로 TV 를 띄우면 DJI 송신기 버튼을 쓸 수 없다 — 수신기는 USB 로 "볼륨 올림" 키를 보내는데,
 * 맥미니에서는 서버가 그 장치를 독점으로 열어 가로채지만(audio/button.py) 폰의 웹페이지는 USB 장치를 잡지 못한다.
 * 그래서 화면에 큰 단추를 두고, 블루투스 리모컨·키보드의 엔터/스페이스/미디어 키도 같은 호출로 받는다.
 * 서버는 이것을 호출 버튼과 똑같이 다룬다 (tv.call -> _on_button).
 */
const KEYS = new Set([" ", "Enter", "MediaPlayPause", "MediaPlay", "AudioPlay"]);

export function mountCallButton(socket: RibbonSocket): void {
  const btn = document.createElement("button");
  btn.id = "call-btn";
  btn.className = "overlay";
  btn.innerHTML = `<span class="c-ic">🎤</span><span class="c-t">리본아!</span>`;
  document.body.appendChild(btn);

  let last = 0;
  const call = (): void => {
    const now = performance.now();
    if (now - last < 1500) return;                 // 아이들이 연달아 누르는 것은 한 번으로
    last = now;
    socket.sendJson({ type: "tv.call" });
    btn.classList.add("pressed");
    setTimeout(() => btn.classList.remove("pressed"), 600);
  };
  btn.onclick = call;
  window.addEventListener("keydown", (ev) => {
    if (KEYS.has(ev.key) && !(ev.target instanceof HTMLInputElement)) {
      ev.preventDefault();
      call();
    }
  });
}
