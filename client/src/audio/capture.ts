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
  /** 채널별 최근 음량 (RMS 0~1). 디버그 패널의 막대 표시용 */
  readonly levels: number[] = [0, 0, 0, 0];
  /** 장치별로 브라우저가 실제로 준 채널 수 (모노로 열렸는지 확인용) */
  readonly opened: { label: string; channelCount: number; channelOffset: number }[] = [];
  /** 워크릿이 실제 채널 수를 알려줄 때 호출 */
  onInfo?: (channelOffset: number, channels: number) => void;
  /** 소리가 날 때 좌우 유사도(상관계수 -1~1)와 R/L 음량비를 0.5초마다 알림 */
  onSimilarity?: (channelOffset: number, corr: number, ratio: number) => void;

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
    this.opened.length = 0;
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
      const track = stream.getAudioTracks()[0];
      const st = track?.getSettings() ?? {};
      this.opened.push({ label: track?.label ?? dev.deviceId, channelCount: (st as { channelCount?: number }).channelCount ?? 0, channelOffset: dev.channelOffset });
      const source = this.ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(this.ctx, "pcm-capture", {
        numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: "explicit",
        processorOptions: { channelOffset: dev.channelOffset },
      });
      node.port.onmessage = (ev) => {
        if (ev.data.info) {
          const o = this.opened.find((x) => x.channelOffset === ev.data.channelOffset);
          if (o) o.channelCount = ev.data.channels as number;
          this.onInfo?.(ev.data.channelOffset as number, ev.data.channels as number);
          return;
        }
        if (ev.data.similarity) {
          if (ev.data.loud) this.onSimilarity?.(ev.data.channelOffset as number, ev.data.corr as number, ev.data.ratio as number);
          return;
        }
        const pcm = ev.data.pcm as Int16Array;
        const ch = ev.data.channel as number;
        let sum = 0;
        for (let i = 0; i < pcm.length; i++) { const v = pcm[i] / 32768; sum += v * v; }
        const rms = Math.sqrt(sum / pcm.length);
        if (ch < this.levels.length) this.levels[ch] = Math.max(rms, this.levels[ch] * 0.8); // 살짝 여운을 둔 피크
        this.socket.sendAudio(ch, pcm);
      };
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
