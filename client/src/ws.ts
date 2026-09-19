import type { ClientRole, ServerMsg } from "./protocol";

type Handler = (msg: ServerMsg) => void;

/** 자동 재접속 WebSocket. JSON 텍스트와 오디오 바이너리 프레임을 모두 보낸다. */
export class RibbonSocket {
  private ws: WebSocket | null = null;
  private handlers: Handler[] = [];
  private lastState: ServerMsg | null = null; // 핸들러 등록 전에 도착한 스냅샷을 나중에 재전달
  private lastGame: ServerMsg | null = null;  // 하던 게임 화면도 (TV 를 새로 열었을 때)
  private lastMic: ServerMsg | null = null;   // 마이크 표시
  private retry = 1000;
  readonly url: string;

  constructor(private role: ClientRole, url?: string) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.url = url ?? `${proto}://${location.host}/ws`;
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.retry = 1000;
      this.sendJson({ type: "hello", role: this.role, client_id: clientId() });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: ServerMsg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "state") this.lastState = msg;
      if (msg.type === "game") this.lastGame = msg;
      if (msg.type === "mic") this.lastMic = msg;
      for (const h of this.handlers) h(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 10000);
    };
    ws.onerror = () => ws.close();
    this.ws = ws;
  }

  on(handler: Handler): void {
    this.handlers.push(handler);
    if (this.lastState) handler(this.lastState);
    if (this.lastGame) handler(this.lastGame);
    if (this.lastMic) handler(this.lastMic);
  }

  get connected(): boolean { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  sendJson(obj: unknown): void {
    if (this.connected) this.ws!.send(JSON.stringify(obj));
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
