import { RibbonSocket } from "./ws";
import type { ClientRole } from "./protocol";

/**
 * 하나의 웹앱을 URL 의 mode 로 나눠 쓴다.
 *   /?mode=tv        노트북 -> TV. 3D 방, 리본이, 대기 순서, 자막 (기본값)
 *   /?mode=entrance  출입구 폰. 카메라로 아이를 알아보고 인사
 *   /?mode=camera    TV 위 폰. 얼굴 위치를 서버로 보내 리본이 시선에 쓴다
 *   /?mode=debug     TV 화면 + 디버그 패널 자동 표시
 *   /?mode=admin     관리자 페이지. 무선 마이크 수신기가 꽂힌 컴퓨터에서 열어 두면 마이크도 받는다 (설정 탭)
 *   /?mode=mic       마이크 전용 화면. 무선 마이크 수신기를 꽂은 기기(폰·노트북)에서 이것만 열어 둔다
 *   /?mode=editor    맵 편집기. 가구 배치와 벽에 거는 그림 (Character_Creator 배치 편집기)
 *   /?mode=art       아이 전시실 꾸미기. 작품 사진을 올리고(배경 지우기) 전시실 벽에 건다
 *   /?mode=snap      폰으로 작품 찍어 보내기. 관리자 설정 → 카메라 탭의 QR 로 연다 (서버로 사진만 보낸다)
 *   /?mode=home      화면 고르기 메뉴. 도메인(ribbon.arthouseribbon.com)으로 들어오면 mode 없이 여기로 온다
 */
const params = new URLSearchParams(location.search);
/** 맥미니 자신에서 연 것인가 (TV·관리자 화면은 여기서 연다). 도메인으로 들어오면 아니다 */
const local = ["localhost", "127.0.0.1", "::1"].includes(location.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname);
// mode 가 없으면: 맥미니에서 열었으면 TV, 도메인(폰 등)으로 들어왔으면 무엇을 할지 고르는 메뉴
const mode = (params.get("mode") ?? (local ? "tv" : "home")) as ClientRole;

/** 관리 화면은 관리자만. 나머지 화면도 로그인한 사람만 (아무도 가입 전이면 그냥 열린다, auth.py) */
const NEEDS_ADMIN: Record<string, string> = {
  admin: "관리자", editor: "맵 편집기", art: "전시실 꾸미기", debug: "디버그",
};

async function boot(): Promise<void> {

  const { requireLogin } = await import("./auth/index");
  await requireLogin({ need: NEEDS_ADMIN[mode] ? "admin" : "member", what: NEEDS_ADMIN[mode] });
  if (mode === "editor") {
    const { startEditor } = await import("./editor/index");
    await startEditor();
    return;
  }
  if (mode === "art") {
    const { startArt } = await import("./art/index");
    await startArt();
    return;
  }
  if (mode === "mic") {
    const { startMicPage } = await import("./mic/index");
    const socket = new RibbonSocket("mic");
    socket.connect();
    startMicPage(socket);
    return;
  }
  if (mode === "home") {
    const { startHome } = await import("./home/index");
    startHome();
    return;
  }
  if (mode === "snap") {
    const { startSnap } = await import("./snap/index");
    await startSnap();
    return;
  }
  const socket = new RibbonSocket(mode === "debug" ? "tv" : mode);
  socket.connect();
  switch (mode) {
    case "entrance": {
      const { startEntrance } = await import("./entrance/index");
      await startEntrance(socket);
      break;
    }
    case "camera": {
      const { startCamera } = await import("./camera/index");
      await startCamera(socket);
      break;
    }
    case "admin": {
      const { startAdmin } = await import("./admin/index");
      await startAdmin(socket);
      break;
    }
    default: {
      const { startTv } = await import("./tv/index");
      await startTv(socket, { debug: mode === "debug" || params.has("debug"), demo: params.has("demo") });
    }
  }
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="padding:24px;color:#f88">${String(e)}</pre>`;
});
