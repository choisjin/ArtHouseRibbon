"""DJI 버튼을 누른 송신기를 소리로 알아낼 수 있는지 확인 (맥미니에서 실행)

hid_probe.py 결과: 송신기 1·2번 버튼 모두 수신기에서 똑같은 "볼륨 올림"([06 01 00])으로 온다.
그래서 버튼 신호만으로는 누가 눌렀는지 모른다. 버튼을 누르는 순간 그 송신기 마이크에 "딸깍" 소리가 들어간다면
어느 채널의 소리가 튀었는지로 구분할 수 있다. 이 스크립트는 버튼 신호가 올 때마다 채널별 소리 크기를 비교한다.

설치:
  pip install hidapi sounddevice numpy

사용법 (관리자 페이지 마이크는 꺼 두거나 닫아도 되고, 켜 둬도 같이 들을 수 있다):
  python tools/button_channel_probe.py              # DJI 입력 장치를 이름으로 찾는다
  python tools/button_channel_probe.py --device 3   # 못 찾으면 번호로 (python tools/mic_test.py 로 목록)

해 볼 것: 방을 조용히 하고, 말하지 않고, 송신기 1번 버튼 3번 -> 2번 버튼 3번.
  줄마다 채널별 [튄 정도] 가 나온다. 누른 송신기 채널만 크게 튀면 구분 가능.
"""
import argparse
import os
import signal
import collections
import sys
import threading
import time

import numpy as np

try:
    import hid
    import sounddevice as sd
except ImportError:
    sys.exit("pip install hidapi sounddevice numpy")

DJI_VENDOR = 0x2CA3
FRAME_S = 0.02


def find_input(name_hint):
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] > 0 and any(h in d["name"].lower() for h in name_hint):
            return i
    return None


def open_button():
    """DJI 수신기 HID 를 연다. 볼륨 키(page 0x0C) 경로부터, 안 되면 다른 경로, 그래도 안 되면 vid/pid 로"""
    devs = [d for d in hid.enumerate() if d["vendor_id"] == DJI_VENDOR
            or "wireless mic" in (d.get("product_string") or "").lower()]
    if not devs:
        sys.exit("DJI 수신기 HID 를 못 찾았습니다 (hid_probe.py 로 확인)")
    devs.sort(key=lambda d: d["usage_page"] != 0x0C)
    errors = []
    for d in devs:
        h = hid.device()
        try:
            h.open_path(d["path"])
            h.set_nonblocking(1)
            return h
        except OSError as e:
            errors.append(f"page={d['usage_page']:#06x} path={d['path']!r}: {e}")
    try:
        h = hid.device()
        h.open(devs[0]["vendor_id"], devs[0]["product_id"])
        h.set_nonblocking(1)
        return h
    except OSError as e:
        errors.append(f"vid/pid: {e}")
    print("\n".join(errors))
    sys.exit("DJI 수신기 HID 를 열 수 없습니다. 맥에서는 한 프로그램만 열 수 있어서, 다른 터미널에 hid_probe.py 가\n"
             "켜져 있으면 끄고 다시 실행하세요. 그래도 안 되면 시스템 설정 > 개인정보 보호 및 보안 > 입력 모니터링 에서\n"
             "터미널을 껐다 켜 보세요.")


def _quit_now(*_):
    # hidapi 가 읽거나 닫는 중이면 KeyboardInterrupt 가 늦거나 안 먹힌다 (맥).
    # 바로 끝낸다. 장치는 프로세스가 끝나면 운영체제가 풀어 준다
    print(flush=True)
    print("끝", flush=True)
    os._exit(0)


def main():
    signal.signal(signal.SIGINT, _quit_now)
    signal.signal(signal.SIGTERM, _quit_now)
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", type=int, help="입력 장치 번호 (mic_test.py 목록)")
    args = ap.parse_args()

    dev = args.device if args.device is not None else find_input(("dji", "wireless mic"))
    if dev is None:
        sys.exit("DJI 입력 장치를 못 찾았습니다. --device 번호로 지정하세요 (python tools/mic_test.py)")
    info = sd.query_devices(dev)
    ch = min(info["max_input_channels"], 2)
    rate = int(info["default_samplerate"]) or 48000
    hop = int(rate * FRAME_S)
    print(f"소리: [{dev}] {info['name']} / {ch}채널 / {rate}Hz")

    # 20ms 마다 채널별 RMS 를 (시각, [rms...]) 로 4초 동안 기억
    frames = collections.deque(maxlen=int(4 / FRAME_S))
    lock = threading.Lock()
    carry = np.zeros((0, ch), dtype=np.float32)

    def on_audio(indata, _n, _t, _status):
        nonlocal carry
        buf = np.concatenate([carry, indata[:, :ch]])
        now = time.monotonic()
        n = len(buf) // hop
        with lock:
            for k in range(n):
                blk = buf[k * hop:(k + 1) * hop]
                t = now - (len(buf) - (k + 1) * hop) / rate
                frames.append((t, np.sqrt(np.mean(blk ** 2, axis=0))))
        carry = buf[n * hop:]

    h = open_button()
    print("버튼: DJI 수신기 HID 열림")

    def analyze(t_press):
        with lock:
            snap = list(frames)
        base = [r for t, r in snap if t_press - 1.5 < t < t_press - 0.3]
        near = [r for t, r in snap if t_press - 0.3 <= t <= t_press + 0.5]
        if len(base) < 10 or not near:
            print("  (소리 기록이 모자람 - 조금 뒤에 다시)")
            return
        b = np.median(np.array(base), axis=0) + 1e-5
        peak = np.max(np.array(near), axis=0)
        ratio = peak / b
        cells = "  ".join(f"채널{c + 1}: {ratio[c]:6.1f}배 (평소 {b[c]:.4f} -> 최대 {peak[c]:.4f})" for c in range(ch))
        order = np.argsort(ratio)[::-1]
        verdict = "?"
        if ratio[order[0]] >= 3 and (ch == 1 or ratio[order[0]] >= 2 * ratio[order[1]]):
            verdict = f"=> 채널{order[0] + 1} 송신기가 누른 것 같음"
        elif ratio[order[0]] < 2:
            verdict = "=> 누름 소리가 거의 안 들어옴"
        else:
            verdict = "=> 두 채널이 비슷하게 튐 (구분 어려움)"
        print(f"  {cells}  {verdict}", flush=True)

    print("\n=== 조용히 하고 송신기 버튼을 하나씩 눌러 보세요 (Ctrl+C 로 끝) ===")
    t0 = time.monotonic()
    with sd.InputStream(device=dev, channels=ch, samplerate=rate, dtype="float32", callback=on_audio):
        try:
            while True:
                r = h.read(64)
                if r and any(r[1:]):
                    t_press = time.monotonic()
                    print(f"{t_press - t0:7.2f}s 버튼 [{' '.join(f'{x:02x}' for x in r)}]", flush=True)
                    time.sleep(0.6)                 # 누른 뒤 소리까지 모은다
                    analyze(t_press)
                else:
                    time.sleep(0.005)
        except KeyboardInterrupt:
            pass
        finally:
            h.close()


if __name__ == "__main__":
    main()
