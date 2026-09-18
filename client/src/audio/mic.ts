import type { RibbonSocket } from "../ws";
import { AudioCapture } from "./capture";

const STORE_KEY = "ribbon.mic.devices";

export interface DeviceRef { deviceId: string; label: string }
/** 고른 마이크: 이 장치의 0번 채널이 논리 채널 몇 번인지 (1세트 0, 2세트 2) */
export interface MicChoice extends DeviceRef { channelOffset: number }

function loadSaved(): MicChoice[] {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as MicChoice[]; } catch { return []; }
}
function save(list: MicChoice[]): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch { /* 저장소 없음 */ }
}

/**
 * 이 컴퓨터의 마이크를 열어 소리를 서버로 보낸다. 관리자 페이지가 연다 (설정 탭에서 장치를 고르고 켠다).
 * 무선 마이크 수신기가 꽂힌 컴퓨터(보통 맥미니)에서 관리자 페이지를 열어 두어야 리본이가 듣는다.
 * - 고른 장치는 이 브라우저에 기억해 두고, 다음에 열면 바로 켠다 (다른 기기에서는 켜지 않는다)
 * - 장치 id 는 브라우저·기기마다 달라서 이름도 같이 기억하고, id 가 바뀌면 이름으로 찾는다
 * - 브라우저가 소리 처리를 잠가 두면(페이지를 누르기 전) 첫 클릭·키 입력에서 푼다
 * - 한 컴퓨터에서 관리자 창을 여러 개 열어도 마이크는 한 창만 받는다 (Web Locks). 안 그러면 소리가 두 번 간다
 */
export class Mic {
  readonly capture: AudioCapture;
  devices: DeviceRef[] = [];
  selected: MicChoice[] = loadSaved();
  msg = "";
  /** 켜짐·잠김·장치 목록·안내가 바뀔 때 */
  onChange?: () => void;
  /** 장치 목록을 한 번이라도 찾았는지 (찾을 때 마이크 권한을 묻는다) */
  listed = false;
  private release: (() => void) | null = null;   // 마이크 잠금 풀기

  constructor(socket: RibbonSocket, opts: { autoStart: boolean }) {
    this.capture = new AudioCapture(socket);
    this.capture.onInfo = (offset, channels) => {
      if (channels === 1) this.setMsg(`마이크 ${offset + 1}·${offset + 2} 장치가 모노입니다. 두 사람이 한 채널로 잡힙니다`);
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", () => { if (this.listed) void this.refresh(); });
    // 이 브라우저에서 켜 둔 적이 있을 때만 장치를 찾고 켠다 (휴대폰으로 관리자를 열 때 마이크 권한을 묻지 않게)
    if (opts.autoStart && this.selected.length) void this.refresh().then(() => this.start(this.selected));
  }

  get running(): boolean { return this.capture.running; }
  get locked(): boolean { return this.running && (this.capture.context?.state as string) !== "running"; }
  /** 화면 막대용 채널 음량 0~1. 읽을 때마다 조금씩 줄어든다 */
  level(ch: number): number {
    const v = Math.min(1, this.capture.levels[ch] * 4);
    this.capture.levels[ch] *= 0.85;
    return v;
  }

  private setMsg(t: string): void { this.msg = t; this.onChange?.(); }

  /** 입력 장치 목록 (처음엔 마이크 권한을 물어본다: 장치 이름을 보려면 필요) */
  async refresh(): Promise<void> {
    this.listed = true;
    const devs = await AudioCapture.listInputs().catch(() => [] as MediaDeviceInfo[]);
    this.devices = devs.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications")
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `마이크 ${i + 1}` }));
    this.selected = this.selected.map((s) => {
      const hit = this.devices.find((d) => d.deviceId === s.deviceId) ?? this.devices.find((d) => d.label === s.label);
      return hit ? { ...s, deviceId: hit.deviceId, label: hit.label } : s;
    });
    this.msg = this.devices.length ? "" : "마이크 장치가 없습니다 (브라우저의 마이크 권한을 허용했는지 확인)";
    this.onChange?.();
  }

  async start(list: MicChoice[]): Promise<void> {
    const uniq = list.filter((d, i) => d.deviceId && list.findIndex((x) => x.deviceId === d.deviceId) === i);
    if (!uniq.length) { this.setMsg("마이크 장치를 고르세요"); return; }
    this.selected = uniq;
    if (!this.release && !(await this.acquire())) {
      this.setMsg("이 컴퓨터의 다른 관리자 창에서 이미 마이크를 받고 있습니다 (그 창에서 끄거나 닫으세요)");
      return;
    }
    try {
      await this.capture.start(uniq.map((d) => ({ deviceId: d.deviceId, channelOffset: d.channelOffset })));
    } catch (e) {
      this.release?.();
      this.release = null;
      this.setMsg(`마이크 열기 실패: ${e}`);
      return;
    }
    save(uniq);
    this.msg = "";
    this.onChange?.();
    await this.unlock();
  }

  async stop(): Promise<void> {
    await this.capture.stop();
    this.release?.();
    this.release = null;
    save([]);          // 다음에 열 때 자동으로 켜지 않는다
    this.onChange?.();
  }

  /** 이 컴퓨터에서 마이크를 받는 창은 하나만. 잠금은 끄거나 창을 닫을 때까지 쥐고 있는다 */
  private acquire(): Promise<boolean> {
    if (!navigator.locks) return Promise.resolve(true);
    return new Promise((ok) => {
      void navigator.locks.request("ribbon.mic", { ifAvailable: true }, (lock) => {
        if (!lock) { ok(false); return undefined; }
        ok(true);
        return new Promise<void>((done) => { this.release = done; });
      });
    });
  }

  private async unlock(): Promise<void> {
    const ctx = this.capture.context;
    if (!ctx || ctx.state === "running") return;
    try { await ctx.resume(); } catch { /* 사용자 동작 전 */ }
    this.onChange?.();
    if ((ctx.state as string) === "running") return;
    const go = async () => {
      await this.capture.context?.resume();
      if (this.capture.context?.state === "running") {
        window.removeEventListener("pointerdown", go);
        window.removeEventListener("keydown", go);
        this.onChange?.();
      }
    };
    window.addEventListener("pointerdown", go);
    window.addEventListener("keydown", go);
  }
}
