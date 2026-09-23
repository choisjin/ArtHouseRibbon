import type { ServerMsg } from "../protocol";
import type { RibbonSocket } from "../ws";

/**
 * TV 화면에서 리본이 부르기 (?mode=tv) — 오른쪽 아래 **작은 종 아이콘** (2026-09-23).
 *
 * 폰으로 TV 를 띄우면 DJI 송신기 버튼을 쓸 수 없다 — 수신기는 USB 로 "볼륨 올림" 키를 보내는데,
 * 맥미니에서는 서버가 그 장치를 독점으로 열어 가로채지만(audio/button.py) 폰의 웹페이지는 USB 장치를 잡지 못한다.
 * 그래서 화면의 종을 누르거나, 블루투스 리모컨·키보드의 엔터/스페이스/미디어 키로도 부를 수 있다.
 * 서버는 이것을 호출 버튼과 똑같이 다룬다 (tv.call -> _on_button).
 *
 * 폰에서 잘 안 눌리던 것을 고침 (2026-09-23):
 *  - 종은 작게 보이지만 **누르는 영역은 구석 손바닥 크기** (#call-btn 전체, 종은 그 안 오른쪽 아래)
 *  - click 이 아니라 **pointerdown** 에서 바로 보낸다 (손을 떼기 전에, 조금 움직여도)
 *  - 누른 즉시 종이 흔들리고 화면 가장자리가 반짝인다 (서버 답을 기다리지 않고)
 *  - 소켓이 끊겨 못 보냈으면 잠시 들고 있다가 다시 연결되면 보낸다. 연타 막기는 실제로 보낸 뒤에만
 *
 * 종의 작은 점은 **말을 받을 수 있는 동안** 켜진다 (서버 mic 메시지).
 */
const KEYS = new Set([" ", "Enter", "MediaPlayPause", "MediaPlay", "AudioPlay"]);
const REPEAT_GAP_MS = 1500;       // 아이들이 연달아 누르는 것은 한 번으로
const PENDING_MAX_MS = 6000;      // 끊긴 사이 누른 것을 다시 연결되면 보내는 시한

const BELL_SVG = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2.5a1.6 1.6 0 0 1 1.6 1.6v.6A6.2 6.2 0 0 1 18.2 10.7v3.6l1.6 2.3a1 1 0 0 1-.8 1.6H5a1 1 0 0 1-.8-1.6l1.6-2.3v-3.6A6.2 6.2 0 0 1 10.4 4.7v-.6A1.6 1.6 0 0 1 12 2.5z"/>
    <path d="M9.6 19.6h4.8a2.4 2.4 0 0 1-4.8 0z"/>
  </svg>`;

export function mountCallButton(socket: RibbonSocket): void {
  const btn = document.createElement("button");
  btn.id = "call-btn";
  btn.className = "overlay";
  btn.title = "리본이 부르기";
  btn.setAttribute("aria-label", "리본이 부르기");
  btn.innerHTML = `<span class="bell">${BELL_SVG}<i class="dot"></i></span>`;
  document.body.appendChild(btn);

  const flash = document.createElement("div");      // 눌렸다는 표시: 화면 가장자리 반짝
  flash.id = "call-flash";
  document.body.appendChild(flash);

  let lastSent = 0;
  let pendingAt = 0;                                 // 못 보낸 누름이 있으면 그 시각

  const feedback = (): void => {
    btn.classList.remove("pressed");
    flash.classList.remove("on");
    void btn.offsetWidth;                            // 애니메이션 다시 시작
    btn.classList.add("pressed");
    flash.classList.add("on");
    setTimeout(() => { btn.classList.remove("pressed"); flash.classList.remove("on"); }, 600);
  };

  const trySend = (): boolean => {
    const now = performance.now();
    if (now - lastSent < REPEAT_GAP_MS) return true;   // 연타: 이미 보낸 것으로 친다
    if (!socket.sendJson({ type: "tv.call" })) return false;
    lastSent = now;
    pendingAt = 0;
    return true;
  };

  const call = (): void => {
    feedback();
    if (!trySend()) pendingAt = performance.now();   // 다시 연결되면 보낸다
  };
  socket.onOpen(() => {
    if (pendingAt && performance.now() - pendingAt < PENDING_MAX_MS) trySend();
    pendingAt = 0;
  });

  // 손이 닿는 순간 보낸다. click 은 손을 뗀 뒤에 오고, 조금 움직이거나 전체화면으로 바뀌면 사라진다
  btn.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 && ev.pointerType === "mouse") return;
    ev.preventDefault();
    call();
  });
  btn.addEventListener("click", (ev) => ev.preventDefault());   // pointerdown 에서 이미 처리
  btn.addEventListener("contextmenu", (ev) => ev.preventDefault());   // 길게 눌러도 메뉴가 뜨지 않게
  window.addEventListener("keydown", (ev) => {
    if (KEYS.has(ev.key) && !(ev.target instanceof HTMLInputElement)) {
      ev.preventDefault();
      call();
    }
  });
  // 블루투스 마이크·리모컨·이어폰의 재생/정지 버튼도 호출로 받는다 (안드로이드는 미디어 키를 이 화면으로 보낸다).
  // 소리를 한 번이라도 낸 뒤에야 미디어 세션이 살아 있어서, 리본이가 말하고 나면 잘 동작한다
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({ title: "리본이 부르기", artist: "리본" });
    } catch { /* 옛 브라우저 */ }
    for (const action of ["play", "pause", "stop", "nexttrack", "previoustrack"] as MediaSessionAction[]) {
      try { ms.setActionHandler(action, () => call()); } catch { /* 이 브라우저가 모르는 동작 */ }
    }
  }
  // 말을 받는 동안 종의 점이 켜진다 (오른쪽 위 마이크 표시와 같은 신호)
  socket.on((m: ServerMsg) => { if (m.type === "mic") btn.classList.toggle("listening", m.on); });
}
