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
