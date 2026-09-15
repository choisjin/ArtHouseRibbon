import type { RibbonSocket } from "../ws";

export interface CaptureDevice {
  deviceId: string;
  channelOffset: number; // 이 장치의 0번 채널이 논리 채널 몇 번인지 (DJI 1세트=0, 2세트=2)
}

/**
 * 마이크(들)를 열어 채널별 PCM 을 서버로 보낸다.
 * - 브라우저 후처리(에코 제거/노이즈 억제/자동 이득)를 끄는 이유: 좌우 채널을 섞거나 모노로 합쳐버리기 때문.
 * - 사용자 제스처(클릭) 뒤에 start() 를 불러야 AudioContext 가 열린다.
 */
export class AudioCapture {
  private ctx: AudioContext | null = null;
  private nodes: AudioWorkletNode[] = [];
  private streams: MediaStream[] = [];

  constructor(private socket: RibbonSocket) {}

  static async listInputs(): Promise<MediaDeviceInfo[]> {
    // 라벨을 받으려면 한 번 권한을 얻어야 한다
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); } catch { /* 권한 거부 */ }
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  }

  async start(devices: CaptureDevice[]): Promise<void> {
    await this.stop();
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule("/pcm-worklet.js");
    for (const dev of devices) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: dev.deviceId ? { exact: dev.deviceId } : undefined,
          channelCount: { ideal: 2 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const source = this.ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(this.ctx, "pcm-capture", {
        numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: "explicit",
        processorOptions: { channelOffset: dev.channelOffset },
      });
      node.port.onmessage = (ev) => this.socket.sendAudio(ev.data.channel, ev.data.pcm as Int16Array);
      source.connect(node);
      this.nodes.push(node);
      this.streams.push(stream);
    }
  }

  async stop(): Promise<void> {
    this.nodes.forEach((n) => n.disconnect());
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.nodes = [];
    this.streams = [];
    if (this.ctx) { await this.ctx.close(); this.ctx = null; }
  }

  get running(): boolean { return this.ctx !== null; }
}
