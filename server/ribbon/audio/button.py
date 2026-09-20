"""호출 버튼: DJI 마이크 송신기 버튼 (2026-09-20).

DJI Mic Mini 수신기는 송신기 버튼을 누르면 USB 로 "볼륨 올림" 키(HID [06 01 00])를 보낸다.
어느 송신기인지는 신호에도 소리에도 드러나지 않아서 (tools/hid_probe.py, button_channel_probe.py 로 확인),
버튼이 눌리면 아이가 등록된 채널을 모두 잠깐 듣고, **가장 먼저 말을 시작한 채널**을 부른 아이로 본다.

- DjiButton: 수신기 HID 를 독점으로 열어 읽는 스레드. 독점이라 맥 음량이 올라가지 않는다. 빠지면 다시 찾는다.
- ButtonCall: 누름 -> 채널들 듣기 시작 -> 먼저 말한 채널 고르기 -> 나머지 끄기 (main.py 가 오디오마다 부른다)
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Callable, Dict, Iterable, List, Optional

log = logging.getLogger("ribbon.button")

DJI_VENDOR = 0x2CA3


class DjiButton:
    def __init__(self, on_press: Callable[[], None], debounce_s: float = 0.8):
        self.on_press = on_press
        self.debounce_s = debounce_s
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.connected = False

    def start(self) -> bool:
        try:
            import hid  # noqa: F401  pip install hidapi
        except ImportError:
            log.warning("hidapi 가 없어 DJI 호출 버튼을 쓰지 않습니다 (pip install hidapi)")
            return False
        self._thread = threading.Thread(target=self._run, name="dji-button", daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop.set()

    def _open(self):
        import hid
        devs = [d for d in hid.enumerate() if d["vendor_id"] == DJI_VENDOR
                or "wireless mic" in (d.get("product_string") or "").lower()]
        devs.sort(key=lambda d: d["usage_page"] != 0x0C)      # 볼륨 키 경로부터
        for d in devs:
            h = hid.device()
            try:
                h.open_path(d["path"])
                return h
            except OSError:
                continue
        return None

    def _run(self) -> None:
        warned = False
        last = 0.0
        while not self._stop.is_set():
            h = self._open()
            if h is None:
                if not warned:
                    log.info("DJI 수신기 버튼을 찾는 중 (USB 로 꽂혀 있어야 합니다. 다른 프로그램이 열고 있으면 못 엽니다)")
                    warned = True
                self._stop.wait(3.0)
                continue
            warned = False
            self.connected = True
            log.info("DJI 호출 버튼 연결됨")
            pressed = False
            try:
                while not self._stop.is_set():
                    r = h.read(64, 500)
                    if not r:
                        continue
                    down = any(r[1:])
                    now = time.monotonic()
                    if down and not pressed and now - last > self.debounce_s:
                        last = now
                        self.on_press()
                    pressed = down
            except OSError:
                log.info("DJI 수신기가 빠졌습니다. 다시 찾습니다")
            finally:
                self.connected = False
                try:
                    h.close()
                except Exception:  # noqa: BLE001
                    pass


class ButtonCall:
    """버튼이 눌린 뒤 먼저 말한 채널 고르기. processors 는 {채널: ChannelProcessor}"""

    def __init__(self, processors: Dict[int, object]):
        self.processors = processors
        self.armed: List[int] = []         # 버튼 때문에 듣기 시작한 채널
        self.until = 0.0

    def press(self, channels: Iterable[int], window_s: float, now: Optional[float] = None) -> List[int]:
        now = time.time() if now is None else now
        self.armed = []
        for ch in channels:
            proc = self.processors.get(ch)
            if proc is not None and proc.state == "idle":
                proc.start_listening(now, window_s)
                self.armed.append(ch)
        self.until = now + window_s
        return list(self.armed)

    def cancel(self) -> None:
        """기다리기를 그만둔다 (버튼을 한 번 더 눌러 입력을 취소했을 때, 2026-09-21)"""
        for ch in self.armed:
            proc = self.processors.get(ch)
            if proc is not None:
                proc.stop_listening()
        self.armed = []
        self.until = 0.0

    def check(self, channel: int, now: Optional[float] = None) -> Optional[int]:
        """오디오 한 조각을 넣은 뒤 부른다. 이 채널이 먼저 말을 시작했으면 채널 번호를 돌려주고 나머지를 끈다"""
        now = time.time() if now is None else now
        if not self.armed:
            return None
        if now > self.until:
            self.armed = []                 # 아무도 말하지 않았다. 채널들은 스스로 듣기를 멈춘다
            return None
        proc = self.processors.get(channel)
        if channel in self.armed and proc is not None and proc.segmenter.in_speech:
            for ch in self.armed:
                if ch != channel:
                    self.processors[ch].stop_listening()
            self.armed = []
            return channel
        return None
