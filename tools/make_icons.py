"""홈 화면 아이콘 만들기 (PWA manifest 용). 라이브러리 없이 PNG 를 직접 쓴다.

    python tools/make_icons.py     -> client/public/icon-192.png, icon-512.png

보라 배경에 흰 리본(나비 매듭). 폰에서 "홈 화면에 추가" 로 TV 화면을 전체화면 앱처럼 열 때 쓴다.
"""
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "client", "public")
BG = (123, 75, 216)        # #7b4bd8
FG = (255, 255, 255)


def rounded(x, y, n):
    """모서리를 둥글게 자른 정사각형 안인가 (0~1 좌표)"""
    r = 0.22
    dx = max(abs(x - 0.5) - (0.5 - r), 0)
    dy = max(abs(y - 0.5) - (0.5 - r), 0)
    return math.hypot(dx, dy) <= r


def bow(x, y):
    """나비 매듭: 가운데 매듭 + 좌우 고리 + 아래 꼬리"""
    cx, cy = 0.5, 0.46
    if math.hypot((x - cx) / 0.075, (y - cy) / 0.085) <= 1:            # 가운데 매듭
        return True
    for side in (-1, 1):                                                # 좌우 고리 (타원)
        ex = cx + side * 0.2
        if math.hypot((x - ex) / 0.175, (y - cy) / 0.14) <= 1:
            return True
    for side in (-1, 1):                                                # 아래로 뻗은 꼬리
        tx = cx + side * 0.085
        t = (y - cy - 0.07) / 0.26
        if 0 <= t <= 1 and abs(x - (tx + side * 0.11 * t)) <= 0.055 * (1 - 0.35 * t):
            return True
    return False


def make(size: int, path: str) -> None:
    rows = []
    for py in range(size):
        row = bytearray([0])                                            # 필터 0
        y = (py + 0.5) / size
        for px in range(size):
            x = (px + 0.5) / size
            if not rounded(x, y, size):
                row += bytes((0, 0, 0, 0))                              # 모서리 밖은 투명
            elif bow(x, y):
                row += bytes(FG) + b"\xff"
            else:
                row += bytes(BG) + b"\xff"
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", raw) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print(" ", os.path.relpath(path, ROOT), f"{len(png) // 1024}KB")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for size in (192, 512):
        make(size, os.path.join(OUT, f"icon-{size}.png"))
