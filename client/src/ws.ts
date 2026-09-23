import type { ClientRole, ServerMsg } from "./protocol";

type Handler = (msg: ServerMsg) => void;

const PING_EVERY_MS = 5000;     // 이만큼마다 ping
const PONG_WAIT_MS = 4000;      // 답이 이 안에 없으면 죽은 소켓으로 보고 끊는다

/**
 * 자동 재접속 WebSocket. JSON 텍스트와 오디오 바이너리 프레임을 모두 보낸다.
 *
 * 폰(2026-09-23): 화면이 꺼졌다 켜지거나 와이파이가 절전에 들어가면 브라우저는 소켓이 열린 줄 알지만 서버에는
 * 닿지 않는다. 그래서 (1) 몇 초마다 ping 을 보내 pong 이 없으면 스스로 끊고 다시 잇고,
 * (2) 화면이 다시 보이면 기다리지 않고 바로 다시 잇는다. sendJson 은 보냈는지(true)를 돌려준다.
 */
export class RibbonSocket {
  private ws: WebSocket | null = null;
  private handlers: Handler[] = [];
  private openHandlers: Array<() => void> = [];
  private lastState: ServerMsg | null = null; // 핸들러 등록 전에 도착한 스냅샷을 나중에 재전달
  private lastGame: ServerMsg | null = null;  // 하던 게임 화면도 (TV 를 새로 열었을 때)
  private lastMic: ServerMsg | null = null;   // 마이크 표시
  private retry = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  readonly url: string;

  constructor(private role: ClientRole, url?: string) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.url = url ?? `${proto}://${location.host}/ws`;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (this.connected) this.ping();        // 살아 있는지 바로 확인
      else this.reconnectNow();
    });
  }

  connect(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.retry = 1000;
      this.sendJson({ type: "hello", role: this.role, client_id: clientId() });
      this.startPing();
      for (const h of this.openHandlers) h();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: ServerMsg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "pong") { this.clearPongWait(); return; }
      if (msg.type === "state") this.lastState = msg;
      if (msg.type === "game") this.lastGame = msg;
      if (msg.type === "mic") this.lastMic = msg;
      for (const h of this.handlers) h(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;             // 이미 다른 소켓으로 갈아탔다
      this.ws = null;
      this.stopPing();
      this.retryTimer = setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 10000);
    };
    ws.onerror = () => ws.close();
    this.ws = ws;
  }

  /** 기다리던 재접속을 지금 바로 (화면이 다시 켜졌을 때) */
  private reconnectNow(): void {
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
    this.retry = 1000;
    this.connect();
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.clearPongWait();
  }

  private clearPongWait(): void {
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  private ping(): void {
    if (!this.connected || this.pongTimer) return;   // 이미 답을 기다리는 중
    const ws = this.ws!;
    this.sendJson({ type: "ping" });
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      if (this.ws !== ws) return;
      // 답이 없다: 죽은 소켓. 끊으면 onclose 가 다시 잇는다 (바로)
      this.retry = 1000;
      try { ws.close(); } catch { /* 이미 닫힘 */ }
    }, PONG_WAIT_MS);
  }

  on(handler: Handler): void {
    this.handlers.push(handler);
    if (this.lastState) handler(this.lastState);
    if (this.lastGame) handler(this.lastGame);
    if (this.lastMic) handler(this.lastMic);
  }

  /** 연결될 때마다 (처음·재접속) 부른다 — 끊긴 사이 못 보낸 것을 다시 보내는 데 쓴다 */
  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }

  get connected(): boolean { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  /** 보냈으면 true. 연결이 없으면 버리고 false */
  sendJson(obj: unknown): boolean {
    if (!this.connected) return false;
    try { this.ws!.send(JSON.stringify(obj)); } catch { return false; }
    return true;
  }

  /** [channel u8][flags u8][int16 PCM ...] */
  sendAudio(channel: number, pcm: Int16Array): void {
    if (!this.connected) return;
    const buf = new ArrayBuffer(2 + pcm.byteLength);
    const view = new Uint8Array(buf);
    view[0] = channel & 0xff;
    view[1] = 0;
    view.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 2);
    this.ws!.send(buf);
  }
}

function clientId(): string {
  try {
    let id = localStorage.getItem("ribbon.client_id");
    if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem("ribbon.client_id", id); }
    return id;
  } catch { return "anon"; }
}
