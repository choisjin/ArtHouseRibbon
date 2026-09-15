"""VA346 듀얼 무선 마이크 채널 분리 테스트

사용법:
  pip install sounddevice numpy
  python tools/mic_test.py            # 장치 목록 출력
  python tools/mic_test.py <장치번호>  # 5초 녹음 후 채널별 음량 출력

테스트 방법:
  1) 마이크 1번만 켜고 말하면서 실행 -> 어느 채널이 커지는지 확인
  2) 마이크 2번만 켜고 말하면서 실행 -> 다른 채널이 커지면 좌우 분리, 같으면 모노 믹스
"""
import sys
import numpy as np
import sounddevice as sd

SECONDS = 5
RATE = 48000


def list_devices():
    print("=== 입력 장치 목록 ===")
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] > 0:
            print(f"[{i}] {d['name']}  입력채널={d['max_input_channels']}  기본샘플레이트={int(d['default_samplerate'])}")


def record(dev):
    info = sd.query_devices(dev)
    ch = min(info["max_input_channels"], 2)
    rate = int(info["default_samplerate"]) or RATE
    print(f"장치: {info['name']} / 채널 {ch} / {rate}Hz")
    print(f"{SECONDS}초 동안 마이크에 말하세요...")
    audio = sd.rec(int(SECONDS * rate), samplerate=rate, channels=ch, device=dev, dtype="float32")
    sd.wait()
    print("=== 채널별 RMS (클수록 소리 큼) ===")
    for c in range(ch):
        rms = float(np.sqrt(np.mean(audio[:, c] ** 2)))
        peak = float(np.max(np.abs(audio[:, c])))
        print(f"채널 {c}: RMS={rms:.4f}  Peak={peak:.4f}")
    if ch == 2:
        corr = float(np.corrcoef(audio[:, 0], audio[:, 1])[0, 1])
        print(f"좌우 상관계수: {corr:.3f}  (1.0에 가까우면 모노 믹스, 낮으면 채널 분리)")
    try:
        import wave
        path = "mic_test.wav"
        pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
        with wave.open(path, "wb") as w:
            w.setnchannels(ch); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm.tobytes())
        print(f"녹음 저장: {path}")
    except Exception as e:
        print("wav 저장 실패:", e)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        list_devices()
    else:
        record(int(sys.argv[1]))
