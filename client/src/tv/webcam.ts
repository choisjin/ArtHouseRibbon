import { FaceLandmarker } from "@mediapipe/tasks-vision";
import wasmLoader from "mediapipe-wasm/vision_wasm_internal.js?url";
import wasmBinary from "mediapipe-wasm/vision_wasm_internal.wasm?url";
import type { DeviceRef, FacePosition, ServerMsg } from "../protocol";
import type { RibbonSocket } from "../ws";

/**
 * TV 웹캠: TV 컴퓨터에 꽂은 웹캠으로 TV 앞 아이들 얼굴을 찾는다 (MediaPipe Face Landmarker, 브라우저 안에서).
 * 영상은 이 브라우저 안에서만 쓰고 저장하거나 보내지 않는다. 얼굴 위치(0~1)만 리본이 시선에 쓴다.
 * 카메라 장치·켜기·끄기·미리보기는 관리자 '설정' 탭에서 고른다 (device.control kind=camera, 소리 출력과 같은 길).
 * 고른 값은 이 브라우저에 기억되어 다음에 TV 화면을 열면 저절로 켜진다.
 * 모델 파일은 public/mediapipe/, wasm 은 패키지에서 빌드에 같이 넣는다 (인터넷 없이 동작).
 */
const KEY = "ribbon.tv.camera";
const MODEL_URL = "/mediapipe/face_landmarker.task";
const INTERVAL_MS = 100;          // 초당 10번이면 시선에 충분하고 3D 화면이 느려지지 않는다
const PREVIEW_S = 20;

interface Saved { on: boolean; deviceId: string }

function load(): Saved {
  try { return { on: false, deviceId: "", ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; }
  catch { return { on: false, deviceId: "" }; }
}

export class TvWebcam {
  /** 켜져서 얼굴을 찾고 있는가 (꺼져 있으면 사람이 있는지 알 수 없다) */
  get running(): boolean { return this.stream !== null && this.landmarker !== null; }
  /** 마지막으로 찾은 얼굴들 (x 는 TV 를 보는 쪽 기준: 아이들 왼쪽이 0) */
  faces: FacePosition[] = [];
  onFaces: (faces: FacePosition[]) => void = () => {};

  private saved = load();
  private stream: MediaStream | null = null;
  private landmarker: FaceLandmarker | null = null;
  private video = document.createElement("video");
  private timer = 0;
  private msg = "";
  private previewUntil = 0;
  private preview: HTMLCanvasElement | null = null;
  private starting: Promise<void> | null = null;

  constructor(private socket: RibbonSocket) {
    this.video.muted = true;
    this.video.playsInline = true;
    socket.on((m: ServerMsg) => {
      if (m.type === "state") void this.report();          // (다시) 연결되면 알린다
      if (m.type !== "device.control" || m.kind !== "camera") return;
      void (async () => {
        try {
          if (m.action === "set") { this.save({ deviceId: m.deviceId }); if (this.saved.on) await this.restart(); }
          else if (m.action === "power") { this.save({ on: m.on }); if (m.on) await this.restart(); else this.stop(); }
          else if (m.action === "preview") {
            this.previewUntil = performance.now() + PREVIEW_S * 1000;
            this.msg = this.running ? "" : "카메라가 꺼져 있어 미리보기를 보일 수 없습니다";
          }
          else if (m.action === "labels") (await navigator.mediaDevices.getUserMedia({ video: true })).getTracks().forEach((t) => t.stop());
        } catch (e) { this.msg = `실패: ${e}`; }
        await this.report();
      })();
    });
    navigator.mediaDevices?.addEventListener?.("devicechange", () => void this.report());
    if (this.saved.on) void this.restart().catch((e) => { this.msg = `실패: ${e}`; }).finally(() => this.report());
    setInterval(() => void this.report(), 5000);          // 얼굴 수가 바뀌는 것을 관리자 화면에 보인다
  }

  private save(p: Partial<Saved>): void {
    this.saved = { ...this.saved, ...p };
    try { localStorage.setItem(KEY, JSON.stringify(this.saved)); } catch { /* 저장소 없음: 이번에만 */ }
  }

  private async restart(): Promise<void> {
    if (this.starting) await this.starting;
    this.stop();
    // 켜다 실패하면 반쯤 켜진 카메라를 끈다 (관리자 화면에 이유가 보인다)
    this.starting = this.start().catch((e) => { this.stop(); throw e; }).finally(() => { this.starting = null; });
    await this.starting;
  }

  private async start(): Promise<void> {
    this.msg = "";
    const id = this.saved.deviceId;
    // 고른 장치가 빠졌으면 아무 카메라나 쓴다
    const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: id ? { ...video, deviceId: { exact: id } } : video });
    } catch (e) {
      if (!id) throw e;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      this.msg = "고른 카메라가 없어 다른 카메라를 씁니다";
    }
    this.video.srcObject = this.stream;
    await this.video.play();
    this.landmarker ??= await createLandmarker();
    const tick = () => {
      if (!this.stream) return;
      this.detect();
      this.timer = window.setTimeout(tick, INTERVAL_MS);
    };
    tick();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.setFaces([]);
    this.drawPreview(null);
  }

  private detect(): void {
    const v = this.video;
    if (!this.landmarker || v.readyState < 2 || !v.videoWidth) return;
    const res = this.landmarker.detectForVideo(v, performance.now());
    const faces = res.faceLandmarks.map((pts) => {
      let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
      for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      // 카메라는 아이들을 마주 보고 찍으므로 좌우를 뒤집어야 아이들 왼쪽이 0 이 된다
      return { x: 1 - (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0 };
    });
    this.setFaces(faces);
    this.drawPreview(res.faceLandmarks.length ? res.faceLandmarks : []);
  }

  private setFaces(faces: FacePosition[]): void {
    this.faces = faces;
    this.onFaces(faces);
  }

  /** 관리자가 "미리보기"를 누르면 TV 구석에 잠깐 카메라 화면과 얼굴 상자를 보인다 (카메라 방향 맞추기) */
  private drawPreview(found: { x: number; y: number }[][] | null): void {
    const show = found !== null && performance.now() < this.previewUntil;
    if (!show) { this.preview?.remove(); this.preview = null; return; }
    if (!this.preview) {
      this.preview = document.createElement("canvas");
      this.preview.className = "overlay";
      this.preview.style.cssText = "left:16px;bottom:16px;width:min(32vw,480px);border-radius:12px;box-shadow:0 4px 14px rgba(0,0,0,.4)";
      document.body.appendChild(this.preview);
    }
    const c = this.preview, v = this.video;
    c.width = 480; c.height = Math.round(480 * v.videoHeight / v.videoWidth);
    const g = c.getContext("2d")!;
    // 거울처럼 보여 줘야 TV 앞에서 보기 편하다
    g.setTransform(-1, 0, 0, 1, c.width, 0);
    g.drawImage(v, 0, 0, c.width, c.height);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.strokeStyle = "#ff5fa2"; g.lineWidth = 3;
    for (const pts of found) {
      const xs = pts.map((p) => (1 - p.x) * c.width), ys = pts.map((p) => p.y * c.height);
      const x0 = Math.min(...xs), y0 = Math.min(...ys);
      g.strokeRect(x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0);
    }
    g.fillStyle = "rgba(0,0,0,.55)"; g.fillRect(0, 0, c.width, 26);
    g.fillStyle = "#fff"; g.font = "16px sans-serif";
    g.fillText(`📷 얼굴 ${found.length}명 · ${Math.ceil((this.previewUntil - performance.now()) / 1000)}초 뒤 닫힘`, 8, 19);
  }

  private async report(): Promise<void> {
    let devices: DeviceRef[] = [];
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput")
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `카메라 ${i + 1}` }));
    } catch { /* 장치 목록을 못 읽음 */ }
    const track = this.stream?.getVideoTracks()[0];
    this.socket.sendJson({
      type: "device.status", kind: "camera",
      supported: !!navigator.mediaDevices?.getUserMedia, on: this.saved.on, running: this.running,
      current: this.saved.deviceId, using: track?.label ?? "", devices, faces: this.faces.length, msg: this.msg,
    });
  }
}

async function createLandmarker(): Promise<FaceLandmarker> {
  const fileset = { wasmLoaderPath: wasmLoader, wasmBinaryPath: wasmBinary };
  const opts = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO" as const,
    numFaces: 6,
    minFaceDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try { return await FaceLandmarker.createFromOptions(fileset, opts("GPU")); }
  catch { return FaceLandmarker.createFromOptions(fileset, opts("CPU")); }
}
