// 마이크 입력을 채널별 16kHz int16 PCM 20ms 프레임으로 잘라 메인 스레드로 보낸다.
// DJI Mic Mini 수신기는 스테레오 모드에서 L=송신기1, R=송신기2 로 들어온다.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = 16000;
    this.frameSamples = 320; // 20ms @16k
    this.channelOffset = (options.processorOptions && options.processorOptions.channelOffset) || 0;
    this.ratio = sampleRate / this.targetRate;
    this.acc = [];   // 채널별 리샘플 누적 버퍼
    this.pos = [];   // 채널별 리샘플 위치(소수)
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    if (!this.reported) {
      // 실제로 들어오는 채널 수 (브라우저 설정값은 macOS 에서 비어 있을 수 있다)
      this.reported = true;
      this.port.postMessage({ info: true, channels: input.length, channelOffset: this.channelOffset });
    }
    // 좌우 유사도: 두 채널이 같은 소리(모노 믹스)인지 확인. 0.5초마다 보고
    if (input.length >= 2) {
      const L = input[0], R = input[1];
      let ll = 0, rr = 0, lr = 0;
      for (let i = 0; i < L.length; i++) { ll += L[i] * L[i]; rr += R[i] * R[i]; lr += L[i] * R[i]; }
      this.simAcc = (this.simAcc || 0) + lr; this.llAcc = (this.llAcc || 0) + ll; this.rrAcc = (this.rrAcc || 0) + rr;
      this.simBlocks = (this.simBlocks || 0) + 1;
      if (this.simBlocks >= Math.round(sampleRate / 128 / 2)) {
        const corr = this.llAcc > 1e-6 && this.rrAcc > 1e-6 ? this.simAcc / Math.sqrt(this.llAcc * this.rrAcc) : 0;
        const ratio = this.llAcc > 1e-9 ? Math.sqrt(this.rrAcc / this.llAcc) : 0;
        this.port.postMessage({ similarity: true, channelOffset: this.channelOffset, corr, ratio, loud: this.llAcc > 1e-3 || this.rrAcc > 1e-3 });
        this.simAcc = this.llAcc = this.rrAcc = 0; this.simBlocks = 0;
      }
    }
    for (let c = 0; c < input.length; c++) {
      const src = input[c];
      if (!src) continue;
      if (!this.acc[c]) { this.acc[c] = []; this.pos[c] = 0; }
      // 선형 보간 다운샘플
      let p = this.pos[c];
      while (p < src.length - 1) {
        const i = Math.floor(p);
        const frac = p - i;
        const v = src[i] * (1 - frac) + src[i + 1] * frac;
        this.acc[c].push(v);
        p += this.ratio;
      }
      this.pos[c] = p - src.length;
      while (this.acc[c].length >= this.frameSamples) {
        const chunk = this.acc[c].splice(0, this.frameSamples);
        const out = new Int16Array(this.frameSamples);
        for (let i = 0; i < this.frameSamples; i++) {
          const s = Math.max(-1, Math.min(1, chunk[i]));
          out[i] = s < 0 ? s * 32768 : s * 32767;
        }
        this.port.postMessage({ channel: this.channelOffset + c, pcm: out }, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
