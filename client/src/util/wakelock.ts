/**
 * 화면 꺼짐 막기 (Wake Lock). https 에서만 된다.
 *
 * 폰이 마이크를 받거나(관리자 화면을 학원 컴퓨터로 쓸 때) TV 화면을 띄우는 동안 화면이 꺼지면
 * 브라우저가 멈춰서 소리·마이크가 끊긴다. 다른 앱에 갔다 돌아오면 잠금이 풀리므로 다시 건다.
 */
let lock: { release(): Promise<void>; released: boolean } | null = null;
let want = false;

export async function keepAwake(on = true): Promise<void> {
  want = on;
  const nav = navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<typeof lock> } };
  if (!on) {
    await lock?.release().catch(() => undefined);
    lock = null;
    return;
  }
  if (!nav.wakeLock || (lock && !lock.released)) return;
  try {
    lock = await nav.wakeLock.request("screen");
  } catch { /* 배터리 절약 중이거나 https 가 아님 */ }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && want) void keepAwake(true);
});
