import type { DeviceRef, MicChoice, ServerMsg } from "../protocol";
import type { RibbonSocket } from "../ws";
import { AudioCapture } from "./capture";

const STORE_KEY = "ribbon.mic.devices";

function loadSaved(): MicChoice[] {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as MicChoice[]; } catch { return []; }
}
function save(list: MicChoice[]): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch { /* 저장소 없음 */ }
}

/**
 * 마이크 에이전트: 무선 마이크 수신기가 꽂힌 컴퓨터의 화면(?mode=mic, TV ?mic=1)에서 돈다.
 * - 이 컴퓨터의 입력 장치 목록·켜짐·채널별 음량을 서버로 알린다 (device.status, kind=mic)
 * - 관리자 '설정' 탭이 고른 장치로 켜고 끈다 (device.control, kind=mic)
 * - 고른 장치는 이 브라우저에 기억해 두고, 다음에 열면 바로 켠다
 * 장치 id 는 브라우저·기기마다 달라서 이름도 같이 기억하고, id 가 바뀌면 이름으로 찾는다.
 */
export class MicAgent {
  readonly capture: AudioCapture;
  devices: DeviceRef[] = [];
  selected: MicChoice[] = loadSaved();
  msg = "";
  onChange?: () => void;
  private tick = 0;

  constructor(private socket: RibbonSocket, opts: { autoStart: boolean }) {
    this.capture = new AudioCapture(socket);
    this.capture.onInfo = (offset, channels) => {
      if (channels === 1) this.setMsg(`채널 ${offset + 1}·${offset + 2} 장치가 모노입니다. 두 사람이 한 채널로 잡힙니다`);
    };
    socket.on((m: ServerMsg) => {
      if (m.type === "device.control" && m.kind === "mic") void this.control(m);
      if (m.type === "state") this.report();                // (다시) 연결되면 바로 알린다
    });
    navigator.mediaDevices?.addEventListener?.("devicechange", () => void this.refresh());
    void this.refresh().then(() => {
      if (opts.autoStart && this.selected.length) void this.start(this.selected);
    });
    // 켜져 있으면 0.25초마다 음량을, 아니면 3초마다 상태만
    setInterval(() => {
      this.tick++;
      if (this.running || this.tick % 12 === 0) this.report();
      for (let c = 0; c < 4; c++) this.capture.levels[c] *= 0.6;
    }, 250);
  }

  get running(): boolean { return this.capture.running; }
  get locked(): boolean { return this.running && (this.capture.context?.state as string) !== "running"; }

  private setMsg(t: string): void { this.msg = t; this.changed(); }
  private changed(): void { this.report(); this.onChange?.(); }

  report(): void {
    this.socket.sendJson({
      type: "device.status", kind: "mic",
      running: this.running, locked: this.locked, devices: this.devices, selected: this.selected,
      opened: this.capture.opened, levels: this.capture.levels.map((v) => Math.round(Math.min(1, v * 4) * 100) / 100),
      msg: this.msg,
    });
  }

  async refresh(): Promise<void> {
    const devs = await AudioCapture.listInputs().catch(() => [] as MediaDeviceInfo[]);
    this.devices = devs.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications")
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `마이크 ${i + 1}` }));
    // 기억한 장치의 id 가 바뀌었으면 이름으로 다시 찾는다
    this.selected = this.selected.map((s) => {
      const hit = this.devices.find((d) => d.deviceId === s.deviceId) ?? this.devices.find((d) => d.label === s.label);
      return hit ? { ...s, deviceId: hit.deviceId, label: hit.label } : s;
    });
    if (!this.devices.length) this.msg = "마이크 장치가 없습니다 (이 컴퓨터에서 마이크 권한을 허용했는지 확인)";
    else if (this.msg.startsWith("마이크 장치가 없습니다")) this.msg = "";
    this.changed();
  }

  async start(list: MicChoice[]): Promise<void> {
    const uniq = list.filter((d, i) => d.deviceId && list.findIndex((x) => x.deviceId === d.deviceId) === i);
    if (!uniq.length) { this.setMsg("마이크 장치를 고르세요"); return; }
    this.selected = uniq;
    try {
      await this.capture.start(uniq.map((d) => ({ deviceId: d.deviceId, channelOffset: d.channelOffset })));
    } catch (e) {
      this.setMsg(`마이크 열기 실패: ${e}`);
      return;
    }
    save(uniq);
    this.msg = "";
    this.changed();
    await this.unlock();
  }

  async stop(): Promise<void> {
    await this.capture.stop();
    save([]);          // 다음에 열 때 자동으로 켜지 않는다
    this.changed();
  }

  /** 브라우저가 소리 처리를 잠가 두면(이 화면을 누르기 전) 첫 클릭·키 입력에서 푼다 */
  private async unlock(): Promise<void> {
    const ctx = this.capture.context;
    if (!ctx || ctx.state === "running") return;
    try { await ctx.resume(); } catch { /* 사용자 동작 전 */ }
    if ((ctx.state as string) === "running") { this.changed(); return; }
    this.changed();       // locked 를 알린다 → 관리자 화면에 "그 화면을 한 번 클릭"
    const go = async () => {
      await this.capture.context?.resume();
      if (this.capture.context?.state === "running") {
        window.removeEventListener("pointerdown", go);
        window.removeEventListener("keydown", go);
        this.changed();
      }
    };
    window.addEventListener("pointerdown", go);
    window.addEventListener("keydown", go);
  }

  private async control(m: Extract<ServerMsg, { type: "device.control" }>): Promise<void> {
    if (m.kind !== "mic") return;
    if (m.action === "start") await this.start(m.devices);
    else if (m.action === "stop") await this.stop();
    else if (m.action === "refresh") await this.refresh();
  }
}
