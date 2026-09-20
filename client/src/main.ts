import { RibbonSocket } from "./ws";
import type { ClientRole } from "./protocol";

/**
 * 하나의 웹앱을 URL 의 mode 로 나눠 쓴다.
 *   /?mode=tv        노트북 -> TV. 3D 방, 리본이, 대기 순서, 자막 (기본값)
 *   /?mode=entrance  출입구 폰. 카메라로 아이를 알아보고 인사
 *   /?mode=camera    TV 위 폰. 얼굴 위치를 서버로 보내 리본이 시선에 쓴다
 *   /?mode=debug     TV 화면 + 디버그 패널 자동 표시
 *   /?mode=admin     관리자 페이지. 무선 마이크 수신기가 꽂힌 컴퓨터에서 열어 두면 마이크도 받는다 (설정 탭)
 *   /?mode=mic       (예전 마이크 화면) → 관리자 설정 탭으로 넘어간다
 *   /?mode=editor    맵 편집기. 가구 배치와 벽에 거는 그림 (Character_Creator 배치 편집기)
 *   /?mode=art       아이 전시실 꾸미기. 작품 사진을 올리고(배경 지우기) 전시실 벽에 건다
 *   /?mode=snap      폰으로 작품 찍어 보내기. 관리자 설정 → 카메라 탭의 QR 로 연다 (서버로 사진만 보낸다)
 */
const params = new URLSearchParams(location.search);
const mode = (params.get("mode") ?? "tv") as ClientRole;

async function boot(): Promise<void> {
  if (mode === "mic") {
    // 마이크 설정·받기는 관리자 설정 탭으로 옮겼다 (예전 주소·start_ribbon 설정을 위해 남겨 둔다)
    location.replace("/?mode=admin#settings");
    return;
  }
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
