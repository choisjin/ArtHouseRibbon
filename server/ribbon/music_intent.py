"""리본이에게 말로 하는 음악 부탁 (Spotify, music.py).

"피카츄 노래 틀어줘" -> 검색해서 틀기, "내 목록 틀어줘" -> 설정에서 고른 목록, "노래 꺼줘", "다음 노래",
"소리 줄여줘", "이 노래 목록에 넣어줘 / 빼줘", "이 노래 뭐야".
포켓몬 게임처럼 규칙으로 알아듣고 대화 모델을 거치지 않는다 (빠르고, 엉뚱한 곡을 틀 일이 적다).
음악과 상관없는 말이면 None -> 보통 대화로.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .music import MusicError, SpotifyAccount
from .settings_store import ConfigStore

log = logging.getLogger("ribbon.music")

_MUSIC = r"(노래|음악|곡|뮤직|스포티파이|스파티파이|spotify)"
_LIST = r"(목록|리스트|플리|플레이리스트)"
_NOT_MUSIC = re.compile(r"(만화|영상|유튜브|티비|tv|텔레비전|불러|부르|이야기|얘기|동화)")
_PLAY = re.compile(r"(틀어(줘|주|봐|줄|$)|틀자|틀래|재생(해|하|시켜)|" + _MUSIC + r".*(들려|켜)(줘|주|줄|봐|$))")


@dataclass
class Intent:
    kind: str            # play | play_list | pause | resume | next | prev | louder | quieter | add | remove | what | show
    query: str = ""


#: "3번", "세 번째", "셋", "삼" -> 3 (목록을 보여 줄 때 지울 노래 고르기)
_NUM_WORDS = {"하나": 1, "한": 1, "일": 1, "첫": 1, "둘": 2, "두": 2, "이": 2, "셋": 3, "세": 3, "삼": 3,
              "넷": 4, "네": 4, "사": 4, "다섯": 5, "오": 5, "여섯": 6, "육": 6, "일곱": 7, "칠": 7,
              "여덟": 8, "팔": 8, "아홉": 9, "구": 9, "열": 10, "십": 10}


def number(text: str) -> Optional[int]:
    """말 속의 번호. 숫자가 먼저, 없으면 한글 수사 ("세 번째" -> 3)"""
    c = _compact(text)
    m = re.search(r"(\d+)", c)
    if m:
        return int(m.group(1))
    for w in sorted(_NUM_WORDS, key=len, reverse=True):
        if re.search(w + r"(번|번째|째|개|곡)", c):
            return _NUM_WORDS[w]
    return _NUM_WORDS.get(c)


def _compact(text: str) -> str:
    return re.sub(r"[^0-9a-z가-힣]", "", text.lower())


def _strip_name(text: str, name: str) -> str:
    names = "|".join(re.escape(n) for n in {name, "리본"} if n)
    return re.sub(rf"^\s*({names})(아|야|이|님)?[\s,.!?~]*", "", text.strip())


def parse(text: str, name: str = "리본") -> Optional[Intent]:
    t = _strip_name(text, name)
    c = _compact(t)
    if not c or re.search(r"(지마|말아|싫어|안틀|안돼)", c):
        return None
    if re.search(_LIST + r".*(보여|보자|봐줘|봐|뭐있|뭐가있|알려)|(무슨|어떤)(노래|곡)(들)?(있|나와)", c):
        return Intent("show")
    if re.search(r"(이|지금|방금|나오는|이거)(노래|곡|음악).*(뭐|무슨|누구|제목)|(노래|곡)제목|^(이거|지금|이게)?무슨(노래|곡)(이야|야|이에요|예요|지)?$", c):
        return Intent("what")
    if re.search(_LIST + r"에(넣|추가|저장|담)|(노래|곡|이거|이것).*(넣어|넣자|추가|저장|담아)", c):
        return Intent("add")
    if re.search(_LIST + r"에서(빼|지워|지우|삭제|없애)|(노래|곡).*(빼|지워|지우|삭제|없애)", c):
        return Intent("remove")
    if re.search(_MUSIC + r".*(꺼|끄|멈춰|멈추|정지|그만)|그만틀|(음악|노래)?일시정지", c):
        return Intent("pause")
    if re.search(r"(다시|계속|이어서)(틀|켜|재생|들려)", c):
        return Intent("resume")
    if re.search(r"(다음|다른)(노래|곡|거)(틀|로|재생|들려|줘|$)|넘겨|스킵|건너뛰", c) and not _NOT_MUSIC.search(c):
        return Intent("next")
    if re.search(r"(이전|앞)(노래|곡|거)(로|틀|다시|재생|들려|줘|$)|아까(그)?(노래|곡)(다시)?(틀|들려|재생)", c):
        return Intent("prev")
    if re.search(r"(소리|볼륨|음악|노래)(좀|를|가|을)?(더|조금|좀)?(키워|크게|올려|높여)", c):
        return Intent("louder")
    if re.search(r"(소리|볼륨|음악|노래)(좀|를|가|을)?(더|조금|좀)?(줄여|작게|낮춰|내려)", c):
        return Intent("quieter")
    if not _PLAY.search(c) or _NOT_MUSIC.search(c):
        return None
    if re.search(r"(내|우리|나의|저장한)(노래|음악)?" + _LIST, c) or re.fullmatch(
            _MUSIC + r"(좀|하나|한곡|아무거나)?(틀어|켜|재생|들려)\w*", c):
        return Intent("play_list")
    q = re.sub(r"(스포티파이|스파티파이|spotify)(에서|로)?", " ", t, flags=re.I)
    q = re.sub(r"\s*(좀|한번|한 번)?\s*(틀어|틀자|틀래|재생|들려|켜)\S*.*$", "", q)
    q = re.sub(r"\s*(노래|음악|곡)?\s*(를|을|좀|하나)?\s*$", "", q)
    q = re.sub(r"[?!.,~]+", " ", q).strip()
    q = re.sub(r"(을|를)$", "", q).strip()
    return Intent("play", q) if q else Intent("play_list")


class MusicControl:
    """말로 한 부탁을 Spotify 조작으로. 재생 화면(Web Playback SDK)이 알려 준 장치·재생 상태를 기억한다"""

    def __init__(self, account: SpotifyAccount, store: ConfigStore,
                 on_config: Optional[Callable[[], Awaitable[None]]] = None):
        self.account = account
        self.store = store
        self.on_config = on_config
        self.devices: Dict[str, str] = {}        # 역할(tv|admin) -> 장치 id
        self.state: Dict[str, Any] = {}          # 재생 화면이 보낸 마지막 상태 (music.state)
        self.state_at = 0.0
        self.last_error = ""
        self.listing: Optional[Dict[str, Any]] = None   # TV 에 띄운 번호 목록 (보여 줘 -> 번호로 빼기)
        self._view_changed = False
        self._undo: Optional[Dict[str, Any]] = None     # 방금 뺀 노래 (되돌려)

    # ---------- 재생 화면이 알려 오는 것 ----------
    def set_device(self, role: str, device_id: str) -> None:
        if device_id:
            self.devices[role] = device_id
        else:
            self.devices.pop(role, None)

    def set_state(self, state: Dict[str, Any]) -> None:
        self.state = state
        self.state_at = time.time()

    @property
    def track(self) -> Optional[Dict[str, Any]]:
        return (self.state or {}).get("track") or None

    def active(self) -> bool:
        """음악이 나오고 있거나 방금(3분 안) 멈췄다: "소리 줄여", "이 노래 뭐야" 같은 말을 음악 이야기로 본다"""
        if not self.track:
            return False
        return bool(self.state.get("playing")) or time.time() - self.state_at < 180

    def device(self) -> str:
        role = self.store.config.music.output
        dev = self.devices.get(role)
        if not dev:
            where = "TV 화면" if role == "tv" else "관리자 화면"
            raise MusicError(f"음악을 틀 {where}이 준비되지 않았습니다 (화면을 열고 한 번 눌러 주세요)")
        return dev

    # ---------- TV 에 띄우는 번호 목록 ----------
    PAGE = 6                                     # 한 번에 보여 주고 읽어 주는 곡 수
    LIST_TIMEOUT_S = 180.0                       # 이만큼 아무 말이 없으면 목록을 내린다

    def tick(self) -> bool:
        """1초마다 (dialogue.tick). 목록 화면이 바뀌었으면 True"""
        if self.listing and time.time() - self.listing.get("at", 0) > self.LIST_TIMEOUT_S:
            log.info("번호 목록을 오래 두어 내림")
            self.close_list()
        return self.take_view_change()

    def list_view(self) -> Optional[Dict[str, Any]]:
        """TV 가 그릴 번호 목록 (music.list). 안 보여 주는 중이면 None"""
        lst = self.listing
        if not lst:
            return None
        start = lst["page"] * self.PAGE
        page = lst["tracks"][start:start + self.PAGE]
        return {"title": lst["title"], "page": lst["page"] + 1,
                "pages": max(1, -(-len(lst["tracks"]) // self.PAGE)), "total": len(lst["tracks"]),
                "items": [{"n": start + i + 1, "title": t["title"], "artists": t["artists"],
                           "art": t.get("album_art") or ""} for i, t in enumerate(page)]}

    def take_view_change(self) -> bool:
        """목록 화면이 바뀌었나 (dialogue 가 보고 TV 에 보낸다)"""
        changed, self._view_changed = self._view_changed, False
        return changed

    def close_list(self) -> None:
        if self.listing is not None:
            self.listing = None
            self._view_changed = True

    def _page_tracks(self) -> List[Dict[str, Any]]:
        lst = self.listing
        return lst["tracks"][lst["page"] * self.PAGE: lst["page"] * self.PAGE + self.PAGE] if lst else []

    async def _do_show(self, it: Intent) -> List[str]:
        pl = await self._default_list()
        tracks = await self.account.playlist_tracks(pl["id"])
        if not tracks:
            self.close_list()
            return [f"{pl['title'] or '내 목록'}에 아직 노래가 없어."]
        self.listing = {"playlist": pl, "title": pl["title"] or "내 목록", "tracks": tracks, "page": 0,
                        "at": time.time()}
        self._view_changed = True
        return [f"{self.listing['title']}에 {len(tracks)}곡 있어.", self._read_page(), "빼고 싶은 노래는 번호를 말해 줘."]

    def _read_page(self) -> str:
        return " ".join(f"{t['n']}번 {t['title']}," for t in (self.list_view() or {}).get("items", [])).rstrip(",")

    async def _listing_turn(self, text: str) -> Optional[List[str]]:
        """목록을 보여 주는 중의 말. 목록과 상관없는 말이면 None (보통 처리로 넘긴다)"""
        lst = self.listing
        lst["at"] = time.time()
        c = re.sub(r"[^0-9a-z가-힣]", "", text.lower())
        if re.search(r"(그만|됐어|닫아|다봤|그만봐|끝)", c):
            self.close_list()
            return ["알겠어!"]
        if re.search(r"(되돌려|되돌리|취소|다시넣|잘못|아까그거)", c) and self._undo:
            return await self._undo_remove()
        if re.search(r"(다음|더보여|더줘|더줄|더있|넘겨|뒤에)", c) or c == "더":
            if (lst["page"] + 1) * self.PAGE >= len(lst["tracks"]):
                return ["이게 마지막이야."]
            lst["page"] += 1
            self._view_changed = True
            return [self._read_page(), "빼고 싶은 노래는 번호를 말해 줘."]
        if re.search(r"(이전|앞에|앞으로|전에거)", c) and lst["page"] > 0:
            lst["page"] -= 1
            self._view_changed = True
            return [self._read_page()]
        n = number(text)
        if n is None:
            return None
        if not 1 <= n <= len(lst["tracks"]):
            return [f"그 번호는 없어. 1번부터 {len(lst['tracks'])}번까지야."]
        return await self._remove_number(n)

    async def _remove_number(self, n: int) -> List[str]:
        lst = self.listing
        pl, track = lst["playlist"], lst["tracks"][n - 1]
        await self.account.remove(pl["id"], [track["uri"]])
        self._undo = {"playlist": pl, "track": track, "position": n - 1}
        lst["tracks"] = [t for i, t in enumerate(lst["tracks"]) if i != n - 1]
        if lst["page"] * self.PAGE >= len(lst["tracks"]) and lst["page"] > 0:
            lst["page"] -= 1
        self._view_changed = True
        log.info("목록에서 뺌(번호 %d): %s <- %s", n, pl.get("title"), track["title"])
        if not lst["tracks"]:
            self.close_list()
            return [f"{track['title']}, 뺐어. 이제 목록이 비었어."]
        return [f"{n}번 {track['title']}, 뺐어.", "더 뺄 노래가 있으면 번호를 말해 줘."]

    async def _undo_remove(self) -> List[str]:
        u = self._undo
        self._undo = None
        await self.account.add(u["playlist"]["id"], [u["track"]["uri"]], position=u["position"])
        if self.listing and self.listing["playlist"]["id"] == u["playlist"]["id"]:
            self.listing["tracks"].insert(u["position"], u["track"])
            self._view_changed = True
        return [f"{u['track']['title']}, 다시 넣었어."]

    # ---------- 말 처리 ----------
    async def handle(self, text: str, name: str = "리본") -> Optional[List[str]]:
        cfg = self.store.config.music
        if not cfg.enabled:
            return None
        if self.listing is not None and self.account.connected:
            try:
                lines = await self._listing_turn(text)
            except MusicError as e:
                self.last_error = str(e)
                log.warning("목록 고치기 실패: %s", e)
                return ["지금은 목록을 고칠 수가 없어. 선생님께 말해 줘."]
            if lines is not None:
                return lines
        intent = parse(text, name)
        if intent is None or (intent.kind in ("what", "louder", "quieter", "prev") and not self.active()):
            # 음악 이야기가 아니다 ("무슨 노래 좋아해?"). 목록을 보여 주는 중이었으면 화면을 내리고 보통 대화로
            self.close_list()
            return None
        if not self.account.connected:
            return ["음악 계정이 아직 연결되지 않았어. 선생님께 부탁해 줘."]
        log.info("음악 부탁: %s %s", intent.kind, intent.query)
        try:
            return await getattr(self, f"_do_{intent.kind}")(intent)
        except MusicError as e:
            self.last_error = str(e)
            log.warning("음악 조작 실패 (%s): %s", intent.kind, e)
            return ["지금은 음악을 틀 수가 없어. 선생님께 말해 줘."]

    async def _default_list(self) -> Dict[str, str]:
        cfg = self.store.config.music
        if cfg.playlist_id:
            return {"id": cfg.playlist_id, "uri": f"spotify:playlist:{cfg.playlist_id}", "title": cfg.playlist_title}
        mine = [p for p in await self.account.playlists() if p["mine"]]
        if not mine:
            raise MusicError("내 재생목록이 없습니다. Spotify 에서 목록을 만들고 설정에서 고르세요")
        return mine[0]

    async def _do_play(self, it: Intent) -> List[str]:
        found = await self.account.search(it.query, limit=5)
        if not found:
            return [f"'{it.query}' 노래는 못 찾았어."]
        await self.account.play(self.device(), uris=[t["uri"] for t in found])
        return [f"{found[0]['title']}, 틀어 줄게!"]

    async def _do_play_list(self, it: Intent) -> List[str]:
        pl = await self._default_list()
        await self.account.play(self.device(), context_uri=pl["uri"])
        return [f"{pl['title'] or '내 목록'}, 틀어 줄게!"]

    async def _do_pause(self, it: Intent) -> List[str]:
        if not (self.state or {}).get("playing"):
            return ["지금 나오는 노래가 없어."]
        await self.account.pause(self.device())
        return ["노래 멈췄어."]

    async def _do_resume(self, it: Intent) -> List[str]:
        if not self.track:
            return await self._do_play_list(it)
        await self.account.resume(self.device())
        return ["다시 틀게!"]

    async def _do_next(self, it: Intent) -> List[str]:
        if not self.track:
            return await self._do_play_list(it)
        await self.account.next(self.device())
        return ["다음 노래!"]

    async def _do_prev(self, it: Intent) -> List[str]:
        await self.account.previous(self.device())
        return ["앞 노래!"]

    async def _volume(self, delta: int) -> int:
        v = max(10, min(100, self.store.config.music.volume + delta))
        self.store.update_music({"volume": v})
        if self.on_config:
            await self.on_config()               # 재생 화면이 새 음량을 받는다 (client/src/music/player.ts)
        return v

    async def _do_louder(self, it: Intent) -> List[str]:
        if self.store.config.music.volume >= 100:
            return ["이게 제일 큰 소리야."]
        await self._volume(15)
        return ["소리 키웠어."]

    async def _do_quieter(self, it: Intent) -> List[str]:
        if self.store.config.music.volume <= 10:
            return ["이게 제일 작은 소리야."]
        await self._volume(-15)
        return ["소리 줄였어."]

    async def _current(self) -> Optional[Dict[str, Any]]:
        return self.track or await self.account.current()

    async def _do_what(self, it: Intent) -> List[str]:
        t = await self._current()
        if not t:
            return ["지금 나오는 노래가 없어."]
        return [f"{t['artists']}의 {t['title']}이야." if t.get("artists") else f"{t['title']}이야."]

    async def _do_add(self, it: Intent) -> List[str]:
        t = await self._current()
        if not t:
            return ["지금 나오는 노래가 없어."]
        pl = await self._default_list()
        if any(x["uri"] == t["uri"] for x in await self.account.playlist_tracks(pl["id"])):
            return ["그 노래는 벌써 목록에 있어."]
        await self.account.add(pl["id"], [t["uri"]])
        log.info("목록에 넣음: %s <- %s", pl.get("title"), t["title"])
        return [f"{t['title']}, 목록에 넣었어!"]

    async def _do_remove(self, it: Intent) -> List[str]:
        t = await self._current()
        if not t:
            return ["지금 나오는 노래가 없어."]
        pl = await self._default_list()
        if not any(x["uri"] == t["uri"] for x in await self.account.playlist_tracks(pl["id"])):
            return ["그 노래는 목록에 없어."]
        await self.account.remove(pl["id"], [t["uri"]])
        log.info("목록에서 뺌: %s -> %s", pl.get("title"), t["title"])
        if self.state.get("playing"):
            await self.account.next(self.device())
        return [f"{t['title']}, 목록에서 뺐어."]
