import type { FacePosition } from "../protocol";
import type { RibbonSocket } from "../ws";

/**
 * TV 위 폰 (2단계 골격). 얼굴 위치를 face.positions 로 보내 리본이 시선에 쓴다.
 * 지금은 브라우저 실험 API(FaceDetector)가 있으면 그것을 쓰고, 없으면 미리보기만 보여준다.
 * 2단계에서 MediaPipe Face Landmarker 로 교체하고, 얼굴 식별(이름 태깅)은 서버에 프레임을 보내 처리한다.
 */
export async function startCamera(socket: RibbonSocket): Promise<void> {
  const root = document.getElementById("app")!;
  root.innerHTML = `
    <div id="mode">
      <div>
        <h2>리본 카메라</h2>
        <video id="cam" autoplay playsinline muted></video>
        <p id="info" style="color:#aaa"></p>
      </div>
    </div>`;
  const video = document.getElementById("cam") as HTMLVideoElement;
  const info = document.getElementById("info")!;
  video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 640, height: 360 }, audio: false });

  const FD = (window as unknown as { FaceDetector?: new (o: object) => { detect(v: HTMLVideoElement): Promise<{ boundingBox: DOMRectReadOnly }[]> } }).FaceDetector;
  if (!FD) {
    info.textContent = "이 브라우저에는 얼굴 검출 API 가 없습니다. 2단계에서 MediaPipe 로 연결합니다. (미리보기만 전송 없음)";
    return;
  }
  const detector = new FD({ fastMode: true, maxDetectedFaces: 6 });
  info.textContent = "얼굴 위치 전송 중";
  const tick = async () => {
    try {
      const w = video.videoWidth || 640, h = video.videoHeight || 360;
      const found = await detector.detect(video);
      const faces: FacePosition[] = found.map((f) => ({
        x: 1 - (f.boundingBox.x + f.boundingBox.width / 2) / w, // 전면 카메라는 좌우 반전
        y: (f.boundingBox.y + f.boundingBox.height / 2) / h,
        w: f.boundingBox.width / w,
      }));
      socket.sendJson({ type: "face.positions", faces });
      info.textContent = `얼굴 ${faces.length}명`;
    } catch (e) { info.textContent = String(e); }
    setTimeout(tick, 200);
  };
  void tick();
}
