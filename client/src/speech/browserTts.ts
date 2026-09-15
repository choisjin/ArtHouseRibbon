import type { SpeakMsg } from "../protocol";
import type { RibbonSocket } from "../ws";

/**
 * speak 메시지 재생. 서버가 wav(base64)를 주면 그것을, 없으면 브라우저 speechSynthesis(ko-KR)로 읽는다.
 * 재생이 끝나면 tts.done 을 보내 서버가 다음 문장/턴으로 넘어가게 한다.
 */
export class Speaker {
  private queue: SpeakMsg[] = [];
  private busy = false;
  onStart?: (msg: SpeakMsg) => void;
  onEnd?: (msg: SpeakMsg) => void;
  onLevel?: (level: number) => void; // 0~1, 입 모양 애니메이션용

  constructor(private socket: RibbonSocket) {}

  enqueue(msg: SpeakMsg): void {
    this.queue.push(msg);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const msg = this.queue.shift()!;
      this.onStart?.(msg);
      try {
        if (msg.audio_b64) await this.playWav(msg.audio_b64);
        else await this.speakBrowser(msg.text);
      } catch (e) { console.warn("tts failed", e); }
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
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ctx = new AudioContext();
    const buffer = await ctx.decodeAudioData(bytes.buffer);
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
    await ctx.close();
  }
}
