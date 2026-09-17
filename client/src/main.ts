import { RibbonSocket } from "./ws";
import type { ClientRole } from "./protocol";

/**
 * 하나의 웹앱을 URL 의 mode 로 나눠 쓴다.
 *   /?mode=tv        노트북 -> TV. 방, 리본이, 아바타, 자막 (기본값)
 *   /?mode=entrance  출입구 폰. 카메라로 아이를 알아보고 인사
 *   /?mode=camera    TV 위 폰. 얼굴 위치를 서버로 보내 리본이 시선에 쓴다
 *   /?mode=debug     TV 화면 + 디버그 패널 자동 표시
 *   /?mode=admin     관리자 페이지. 아이 목록, 리본이 목소리·겉모습, TV 에 보여줄 방
 *   /?mode=editor    맵 편집기. 가구 배치와 벽에 거는 그림 (Character_Creator 배치 편집기)
 */
const params = new URLSearchParams(location.search);
const mode = (params.get("mode") ?? "tv") as ClientRole;

async function boot(): Promise<void> {
  if (mode === "editor") {
    const { startEditor } = await import("./editor/index");
    await startEditor();
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
