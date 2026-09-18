import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import wasmLoader from "mediapipe-wasm/vision_wasm_internal.js?url";
import wasmBinary from "mediapipe-wasm/vision_wasm_internal.wasm?url";
import type { DeviceRef, FacePosition } from "../protocol";
import type { RibbonSocket } from "../ws";

const STORE_KEY = "ribbon.camera";
const MODEL_URL = "/mediapipe/face_landmarker.task";
const INTERVAL_MS = 100;          // 초당 10번이면 시선에 충분하다

interface Saved { on: boolean; deviceId: string; label: string }

function loadSaved(): Saved {
  try { return { on: false, deviceId: "", label: "", ...JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") }; }
  catch { return { on: false, deviceId: "", label: "" }; }
}

/**
 * 이 컴퓨터의 웹캠으로 TV 앞 아이들 얼굴을 찾아 위치를 서버로 보낸다 (face.positions → TV 의 리본이 시선).
 * 마이크처럼 관리자 페이지가 연다: 웹캠이 꽂힌 컴퓨터(맥미니)에서 관리자 '설정' 탭에서 고르고 켠다.
 * - 얼굴 찾기는 브라우저 안에서 (MediaPipe Face Landmarker). 영상은 저장하거나 보내지 않고 위치(0~1)만 보낸다
 * - 얼굴이 없어도 빈 목록을 계속 보낸다. TV 는 이것으로 "TV 앞에 아무도 없다"를 안다
 * - 고른 장치는 이 브라우저에 기억해 두고, 다음에 열면 바로 켠다 (장치 id 가 바뀌면 이름으로 찾는다)
 * - 한 컴퓨터에서 관리자 창을 여러 개 열어도 카메라는 한 창만 받는다 (Web Locks)
 * - 관리자 창이 뒤에 가려져 있어도 돌도록, 박자는 Worker 타이머로 맞춘다 (창 타이머는 숨으면 느려진다)
 * 모델 파일은 public/mediapipe/, wasm 은 패키지에서 빌드에 같이 넣는다 (인터넷 없이 동작).
 */
export class FaceCam {
  devices: DeviceRef[] = [];
  saved = loadSaved();
  msg = "";
  /** 마지막으로 찾은 얼굴 (x 는 아이들 쪽에서 본 기준: 아이들 왼쪽이 0) */
  faces: FacePosition[] = [];
  /** 미리보기용 얼굴 상자 (카메라 영상 좌표 0~1, 뒤집기 전) */
  boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  /** 켜짐·장치 목록·안내가 바뀔 때 */
  onChange?: () => void;
  listed = false;
  readonly video = document.createElement("video");

  private stream: MediaStream | null = null;
  private landmarker: FaceLandmarker | null = null;
  private ticker: Worker | null = null;
  private release: (() => void) | null = null;
  private busy = false;

  constructor(private socket: RibbonSocket, opts: { autoStart: boolean }) {
    this.video.muted = true;
    this.video.playsInline = true;
    navigator.mediaDevices?.addEventListener?.("devicechange", () => { if (this.listed) void this.refresh(); });
    // 이 브라우저에서 켜 둔 적이 있을 때만 켠다 (휴대폰으로 관리자를 열 때 카메라 권한을 묻지 않게)
    if (opts.autoStart && this.saved.on) void this.refresh().then(() => this.start(this.saved.deviceId));
  }

  get running(): boolean { return this.stream !== null && this.landmarker !== null; }
  /** 지금 쓰는 장치 이름 */
  get using(): string { return this.stream?.getVideoTracks()[0]?.label ?? ""; }

  private setMsg(t: string): void { this.msg = t; this.onChange?.(); }

  private save(p: Partial<Saved>): void {
    this.saved = { ...this.saved, ...p };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.saved)); } catch { /* 저장소 없음 */ }
  }

  /** 카메라 목록 (처음엔 카메라 권한을 물어본다: 장치 이름을 보려면 필요) */
  async refresh(): Promise<void> {
    this.listed = true;
    try {
      let devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      if (devs.length && !devs[0].label) {
        (await navigator.mediaDevices.getUserMedia({ video: true })).getTracks().forEach((t) => t.stop());
        devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      }
      this.devices = devs.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `카메라 ${i + 1}` }));
    } catch { this.devices = []; }
    const hit = this.devices.find((d) => d.deviceId === this.saved.deviceId) ?? this.devices.find((d) => d.label === this.saved.label);
    if (hit) this.save({ deviceId: hit.deviceId, label: hit.label });
    this.msg = this.devices.length ? "" : "카메라가 없습니다 (브라우저의 카메라 권한을 허용했는지 확인)";
    this.onChange?.();
  }

  async start(deviceId: string): Promise<void> {
    await this.close();
    if (!this.release && !(await this.acquire())) {
      this.setMsg("이 컴퓨터의 다른 관리자 창에서 이미 카메라를 쓰고 있습니다 (그 창에서 끄거나 닫으세요)");
      return;
    }
    try {
      const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: deviceId ? { ...video, deviceId: { exact: deviceId } } : video,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.landmarker ??= await createLandmarker();
    } catch (e) {
      await this.close();
      this.release?.();
      this.release = null;
      this.setMsg(`카메라 열기 실패: ${e}`);
      return;
    }
    const label = this.devices.find((d) => d.deviceId === deviceId)?.label ?? "";
    this.save({ on: true, deviceId, label });
    this.ticker = startTicker(() => this.tick());
    this.msg = "";
    this.onChange?.();
  }

  async stop(): Promise<void> {
    await this.close();
    this.release?.();
    this.release = null;
    this.save({ on: false });          // 다음에 열 때 자동으로 켜지 않는다
    this.onChange?.();
  }

  private async close(): Promise<void> {
    this.ticker?.terminate();
    this.ticker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    if (this.faces.length) this.socket.sendJson({ type: "face.positions", faces: [] });
    this.faces = [];
    this.boxes = [];
  }

  private tick(): void {
    const v = this.video;
    if (this.busy || !this.landmarker || v.readyState < 2 || !v.videoWidth) return;
    this.busy = true;
    try {
      const res = this.landmarker.detectForVideo(v, performance.now());
      this.boxes = res.faceLandmarks.map((pts) => {
        let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
        for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
        return { x0, y0, x1, y1 };
      });
      // 카메라는 아이들을 마주 보고 찍으므로 좌우를 뒤집어야 아이들 왼쪽이 0 이 된다
      this.faces = this.boxes.map((b) => ({ x: 1 - (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, w: b.x1 - b.x0 }));
      this.socket.sendJson({ type: "face.positions", faces: this.faces });
    } finally { this.busy = false; }
  }

  /** 이 컴퓨터에서 카메라를 쓰는 창은 하나만. 잠금은 끄거나 창을 닫을 때까지 쥐고 있는다 */
  private acquire(): Promise<boolean> {
    if (!navigator.locks) return Promise.resolve(true);
    return new Promise((ok) => {
      void navigator.locks.request("ribbon.camera", { ifAvailable: true }, (lock) => {
        if (!lock) { ok(false); return undefined; }
        ok(true);
        return new Promise<void>((done) => { this.release = done; });
      });
    });
  }
}

/** 창이 숨어도 느려지지 않는 박자 (Worker 안의 타이머) */
function startTicker(fn: () => void): Worker {
  const src = `setInterval(() => postMessage(0), ${INTERVAL_MS});`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  w.onmessage = fn;
  return w;
}

/** MediaPipe 는 커서 카메라를 켤 때 읽는다 (휴대폰으로 관리자를 열 때는 받지 않게) */
async function createLandmarker(): Promise<FaceLandmarker> {
  const { FaceLandmarker } = await import("@mediapipe/tasks-vision");
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
