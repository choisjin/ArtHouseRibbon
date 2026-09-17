import type { SpeakMsg } from "../protocol";
import type { RibbonSocket } from "../ws";

/**
 * speak 메시지 재생. 서버가 wav(base64)를 주면 그것을, 없으면 브라우저 speechSynthesis(ko-KR)로 읽는다.
 * 재생이 끝나면 tts.done 을 보내 서버가 다음 문장/턴으로 넘어가게 한다.
 */
export class Speaker {
  private queue: SpeakMsg[] = [];
  private busy = false;
  private ctx: AudioContext | null = null;
  onStart?: (msg: SpeakMsg) => void;
  onEnd?: (msg: SpeakMsg) => void;
  onLevel?: (level: number) => void; // 0~1, 입 모양 애니메이션용

  constructor(private socket: RibbonSocket, opts: { showLock?: boolean } = {}) {
    // 브라우저는 사용자 동작 전에는 오디오 재생을 막는다. 첫 클릭/터치/키 입력에서 풀어 둔다.
    const unlock = () => {
      void this.audioContext().resume().then(() => { if (this.unlocked) { this.hideUnlockHint(); this.report("소리 잠금 풀림"); } });
    };
    for (const ev of ["pointerdown", "touchstart", "keydown"]) window.addEventListener(ev, unlock, { passive: true });
    if (opts.showLock && !this.muted) {
      // TV: 열자마자 잠겨 있는지 보고, 잠겨 있으면 풀릴 때까지 안내를 띄워 둔다 (대사 소리가 건너뛰어지지 않게)
      const ctx = this.audioContext();
      void ctx.resume().catch(() => undefined).finally(() => {
        window.setTimeout(() => {
          if (this.unlocked) return;
          this.showUnlockHint();
          this.report("소리가 잠겨 있음 (TV 화면을 한 번 클릭해야 함)");
        }, 300);
      });
      ctx.addEventListener("statechange", () => { if (this.unlocked) this.hideUnlockHint(); });
    }
  }

  /** 서버 창에 남기기 (원격에서 원인 찾기용) */
  private report(text: string): void {
    this.socket.sendJson({ type: "client.log", text });
  }

  /** 오디오 컨텍스트 하나를 공유한다 (매번 만들면 자동재생 차단에 걸린다). */
  private audioContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  get unlocked(): boolean { return !!this.ctx && this.ctx.state === "running"; }

  private showUnlockHint(): void {
    let el = document.getElementById("unlock");
    if (!el) {
      el = document.createElement("div");
      el.id = "unlock";
      el.className = "overlay";
      el.style.cssText = "left:50%;top:14vh;transform:translateX(-50%);background:#ffd54a;color:#222;padding:14px 24px;border-radius:14px;font-size:24px;font-weight:700;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35)";
      el.textContent = "🔊 소리 켜기 (화면을 한 번 클릭하세요)";
      document.body.appendChild(el);
    }
    el.style.display = "block";
  }

  private hideUnlockHint(): void {
    const el = document.getElementById("unlock");
    if (el) el.style.display = "none";
  }

  enqueue(msg: SpeakMsg): void {
    this.queue.push(msg);
    void this.drain();
  }

  /** ?mute=1 이면 소리를 내지 않고 글자 수에 비례한 시간만 흘려보낸다 (자동 테스트용) */
  private muted = new URLSearchParams(location.search).has("mute");

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const msg = this.queue.shift()!;
      this.onStart?.(msg);
      try {
        if (this.muted) await new Promise((r) => setTimeout(r, 300 + msg.text.length * 60));
        else if (msg.audio_b64) await this.playWav(msg.audio_b64);
        else await this.speakBrowser(msg.text);
      } catch (e) {
        console.warn("tts failed", e);
        this.report(`대사 소리 재생 실패: ${e}`);
      }
      this.onEnd?.(msg);
      this.socket.sendJson({ type: "tts.done", utterance_id: msg.utterance_id });
    }
    this.busy = false;
  }

  private speakBrowser(text: string): Promise<void> {
    return new Promise((resolve) => {
      const fallbackMs = 600 + text.length * 160; // 음성이 없거나 끝 이벤트가 안 오면 이 시간 뒤에 넘어간다
      if (!("speechSynthesis" in window)) { setTimeout(resolve, fallbackMs); return; }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ko-KR";
      u.rate = 1.0;
      u.pitch = 1.15;
      const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith("ko"));
      if (voice) u.voice = voice;
      let ticker = 0;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearInterval(ticker); clearTimeout(guard);
        this.onLevel?.(0);
        resolve();
      };
      const guard = window.setTimeout(() => { speechSynthesis.cancel(); done(); }, fallbackMs * 2);
      u.onstart = () => { ticker = window.setInterval(() => this.onLevel?.(0.4 + Math.random() * 0.6), 90); };
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    });
  }

  private async playWav(b64: string): Promise<void> {
    const ctx = this.audioContext();
    const running = () => (ctx.state as string) === "running";
    if (!running()) {
      try { await ctx.resume(); } catch { /* 사용자 동작 전 */ }
    }
    if (!running()) {
      // 아직 잠겨 있으면 안내를 띄우고 최대 4초 기다린 뒤, 그래도 안 풀리면 이 문장은 건너뛴다
      this.showUnlockHint();
      for (let i = 0; i < 40 && !running(); i++) await new Promise((r) => setTimeout(r, 100));
      if (!running()) {
        console.warn("audio locked; skipped");
        this.report("소리가 잠겨 있어 대사 한 문장을 건너뜀 (TV 화면을 한 번 클릭)");
        return;
      }
    }
    this.hideUnlockHint();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    const src = ctx.createBufferSource();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.buffer = buffer;
    src.connect(analyser);
    analyser.connect(ctx.destination);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const ticker = window.setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) { const d = (v - 128) / 128; sum += d * d; }
      this.onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 4));
    }, 50);
    await new Promise<void>((resolve) => { src.onended = () => resolve(); src.start(); });
    clearInterval(ticker);
    this.onLevel?.(0);
    src.disconnect();
    analyser.disconnect();
  }
}
