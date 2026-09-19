"""DJI 마이크 버튼 신호 확인 (맥미니에서 실행)

DJI 수신기 버튼을 누르면 맥 음량이 올라간다 = 수신기가 USB 로 "볼륨 올림" 키(HID Consumer Control)를 보낸다.
이 스크립트는 그 신호를 찍어서, 송신기마다 신호가 다른지(어느 아이가 눌렀는지 알 수 있는지) 확인한다.

설치:
  pip install hidapi

사용법:
  python tools/hid_probe.py            # 장치 목록 + DJI(또는 볼륨 키를 보낼 수 있는 장치) 신호 찍기
  python tools/hid_probe.py --all      # 볼륨 키를 보낼 수 있는 모든 장치를 듣기 (DJI 를 못 찾을 때)

해 볼 것 (신호가 뜰 때마다 몇 번 눌렀는지 적어 두기):
  1) 송신기 1번 버튼만 3번  2) 송신기 2번 버튼만 3번  3) 수신기 버튼 3번  (두 세트면 다른 세트도)
  -> 줄마다 [장치] 와 [보고 바이트] 가 나온다. 송신기마다 다르면 누가 눌렀는지 구분할 수 있다.

맥에서 아무것도 안 뜨면: 시스템 설정 > 개인정보 보호 및 보안 > 입력 모니터링 에서 터미널을 켜고 다시 실행.
이 스크립트는 듣기만 한다 (맥 음량은 그대로 올라간다). Ctrl+C 로 끝.
"""
import argparse
import os
import signal
import sys
import time

try:
    import hid
except ImportError:
    sys.exit("hidapi 가 없습니다: pip install hidapi")

DJI_VENDOR = 0x2CA3
CONSUMER_PAGE = 0x0C                       # 볼륨·재생 같은 미디어 키
USAGES = {0xE9: "볼륨 올림", 0xEA: "볼륨 내림", 0xE2: "음소거", 0xCD: "재생/일시정지",
          0xB5: "다음 곡", 0xB6: "이전 곡", 0xB7: "정지"}


def label(d):
    name = f"{d.get('manufacturer_string') or ''} {d.get('product_string') or ''}".strip() or "(이름 없음)"
    return f"{name} [vid={d['vendor_id']:04x} pid={d['product_id']:04x} if={d.get('interface_number')}]"


def guess(report):
    """보고 바이트에서 아는 미디어 키를 찾아 본다 (장치마다 형식이 달라서 추측)"""
    found = []
    for i in range(len(report)):
        v = report[i] | ((report[i + 1] << 8) if i + 1 < len(report) else 0)
        for code in (report[i], v):
            if code in USAGES and USAGES[code] not in found:
                found.append(USAGES[code])
    if not found and len(report) >= 2 and report[1] & 0x01 and not any(report[2:]):
        found.append("눌림 (첫 번째 키, DJI 는 볼륨 올림)")   # DJI Mic Mini 수신기: [06 01 00]
    return ", ".join(found) or ("(놓음)" if not any(report[1:]) else "?")


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
    ap.add_argument("--all", action="store_true", help="DJI 말고도 미디어 키를 보낼 수 있는 모든 장치")
    args = ap.parse_args()

    devs = hid.enumerate()
    print("=== HID 장치 ===")
    for d in devs:
        mark = " <- DJI" if d["vendor_id"] == DJI_VENDOR or "dji" in (d.get("manufacturer_string") or "").lower() else ""
        print(f"  page={d['usage_page']:#06x} usage={d['usage']:#06x}  {label(d)}{mark}")

    def is_dji(d):
        text = f"{d.get('manufacturer_string')} {d.get('product_string')}".lower()
        return d["vendor_id"] == DJI_VENDOR or "dji" in text

    targets = [d for d in devs if is_dji(d)]
    if args.all or not targets:
        if not targets:
            print("\nDJI 장치를 이름으로 못 찾아서, 미디어 키를 보낼 수 있는 장치를 모두 듣습니다.")
        targets = [d for d in devs if d["usage_page"] == CONSUMER_PAGE] + targets

    opened = []
    seen = set()
    for d in targets:
        if d["path"] in seen:
            continue
        seen.add(d["path"])
        try:
            h = hid.device()
            h.open_path(d["path"])
            h.set_nonblocking(1)
            opened.append((h, d))
        except OSError as e:
            print(f"  열 수 없음: {label(d)}  ({e})")
    if not opened:
        sys.exit("열 수 있는 장치가 없습니다. 입력 모니터링 권한을 확인하세요.")

    print(f"\n=== {len(opened)}개 장치를 듣는 중. 버튼을 눌러 보세요 (Ctrl+C 로 끝) ===")
    for i, (_, d) in enumerate(opened):
        print(f"  #{i}: {label(d)} page={d['usage_page']:#06x}")
    t0 = time.time()
    try:
        while True:
            got = False
            for i, (h, d) in enumerate(opened):
                r = h.read(64)
                if r:
                    got = True
                    print(f"{time.time() - t0:7.2f}s  #{i} {d.get('product_string') or ''}  "
                          f"[{' '.join(f'{b:02x}' for b in r)}]  {guess(r)}", flush=True)
            if not got:
                time.sleep(0.005)
    except KeyboardInterrupt:
        pass
    finally:
        for h, _ in opened:
            h.close()


if __name__ == "__main__":
    main()
