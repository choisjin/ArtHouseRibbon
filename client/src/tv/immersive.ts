/**
 * TV 화면을 화면 가득 (?mode=tv).
 *
 * - **전체화면**: 브라우저 주소창·탭을 없앤다. 브라우저 규칙상 사람이 한 번 건드려야 들어갈 수 있어서,
 *   첫 터치·클릭·키 입력에서 요청한다 (TV 화면은 어차피 소리 잠금을 풀려고 한 번 눌러야 한다).
 *   아직 전체화면이 아니면 오른쪽 아래에 작은 "⛶ 화면 가득" 단추를 보여 준다.
 * - **화면 꺼짐 막기**: Wake Lock (https 에서만 된다). 다른 앱에 갔다 오면 다시 건다.
 * - 폰에서 "홈 화면에 추가" 로 열면 (manifest display: fullscreen) 처음부터 주소창 없이 뜬다.
 */
import { keepAwake } from "../util/wakelock";

async function goFull(): Promise<void> {
  if (document.fullscreenElement) return;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
  } catch { /* iOS 사파리 등: 전체화면 API 가 없다 ("홈 화면에 추가" 로 열면 된다) */ }
}

export function startImmersive(): void {
  const btn = document.createElement("button");
  btn.id = "fullscreen-btn";
  btn.className = "overlay";
  btn.textContent = "⛶ 화면 가득";
  btn.onclick = () => { void goFull(); void keepAwake(); };
  document.body.appendChild(btn);

  const show = () => { btn.hidden = !!document.fullscreenElement; };
  document.addEventListener("fullscreenchange", show);
  show();

  // 첫 터치에서 같이 시도한다 (소리 잠금 풀기와 같은 손짓)
  const once = () => { void goFull(); void keepAwake(); };
  for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, once, { once: true, passive: true });
  void keepAwake();
}
