"""Spotify (관리자 '설정' 탭 → 🎵 음악, 말로 조작은 music_intent.py).

로그인: developer.spotify.com 에서 만든 앱의 Client ID/Secret 을 설정에 넣고 "Spotify 로그인" -> 동의 ->
  http://127.0.0.1:<포트>/api/music/callback 으로 돌아오면 갱신 토큰(refresh token)을 저장한다.
  Spotify 는 redirect 주소로 localhost 를 받지 않고 127.0.0.1 만 받는다 -> 로그인은 서버 컴퓨터(맥미니) 브라우저에서.
  다른 컴퓨터에서 로그인했으면 실패한 창의 주소를 통째로 붙여 넣는다 (finish_from_url).
앱 정보·토큰은 data/spotify_auth.json 에만 두고 화면·상태 방송에는 내보내지 않는다 (재생 화면이 쓰는 접근 토큰만 준다).

재생: TV 화면이나 관리자 페이지가 Web Playback SDK 로 "Spotify 스피커"가 되고(client/src/music/player.ts),
  그 장치 id 로 여기서 Web API 를 불러 튼다. Premium 계정만 된다.
2026-03 개발 모드 변경: 재생목록 곡은 /playlists/{id}/items (item 필드), 검색은 한 번에 10개까지.
"""
from __future__ import annotations

import base64
import json
import logging
import secrets
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

log = logging.getLogger("ribbon.music")

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API = "https://api.spotify.com/v1"
SCOPES = " ".join([
    "streaming", "user-read-email", "user-read-private",                 # Web Playback SDK
    "user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing",
    "playlist-read-private", "playlist-read-collaborative", "playlist-modify-private", "playlist-modify-public",
])


class MusicError(Exception):
    """화면·리본이 말로 그대로 보여 줄 수 있는 실패"""


def _image(obj: Dict) -> str:
    imgs = obj.get("images") or []
    return imgs[0]["url"] if imgs else ""


def track_info(t: Dict) -> Dict[str, Any]:
    return {"uri": t.get("uri") or "", "title": t.get("name") or "",
            "artists": ", ".join(a.get("name", "") for a in t.get("artists") or []),
            "album_art": _image(t.get("album") or {}), "duration_ms": t.get("duration_ms") or 0}


class SpotifyAccount:
    def __init__(self, auth_path: Path):
        self.auth_path = auth_path
        self.data: Dict[str, Any] = {}
        self._state = ""                     # 로그인 요청과 돌아온 주소를 짝짓는 값
        self._redirect = ""
        self.error = ""
        self._client = httpx.AsyncClient(timeout=15.0)
        if auth_path.exists():
            try:
                self.data = json.loads(auth_path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001 - 깨진 파일: 다시 로그인
                self.data = {}

    # ---------- 앱 정보 · 로그인 ----------
    def _save(self) -> None:
        self.auth_path.parent.mkdir(parents=True, exist_ok=True)
        self.auth_path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")

    @property
    def has_app(self) -> bool:
        return bool(self.data.get("client_id") and self.data.get("client_secret"))

    @property
    def connected(self) -> bool:
        return self.has_app and bool(self.data.get("refresh_token"))

    def set_app(self, client_id: str, client_secret: str) -> None:
        """앱을 바꾸면 예전 로그인은 버린다 (다른 앱의 토큰은 쓸 수 없다)"""
        client_id, client_secret = client_id.strip(), client_secret.strip()
        if not client_id:
            raise MusicError("Client ID 를 넣으세요")
        if client_id != self.data.get("client_id"):
            self.data = {"client_id": client_id}
        if client_secret:
            self.data["client_secret"] = client_secret
        if not self.data.get("client_secret"):
            raise MusicError("Client Secret 을 넣으세요")
        self._save()

    def login_url(self, redirect_uri: str) -> str:
        if not self.has_app:
            raise MusicError("먼저 Spotify 앱의 Client ID 와 Secret 을 저장하세요")
        self._state = secrets.token_urlsafe(16)
        self._redirect = redirect_uri
        return AUTH_URL + "?" + urlencode({"client_id": self.data["client_id"], "response_type": "code",
                                           "redirect_uri": redirect_uri, "scope": SCOPES, "state": self._state,
                                           "show_dialog": "true"})

    async def finish(self, code: str, state: str) -> Dict[str, str]:
        if not self._state or state != self._state:
            raise MusicError("로그인 요청이 맞지 않습니다. 관리자 페이지에서 다시 'Spotify 로그인' 을 누르세요")
        self._state = ""
        tok = await self._token({"grant_type": "authorization_code", "code": code, "redirect_uri": self._redirect})
        self.data["refresh_token"] = tok["refresh_token"]
        self._keep(tok)
        me = await self.api("GET", "/me")
        self.data["account"] = {"name": me.get("display_name") or me.get("id") or "", "id": me.get("id") or "",
                                "photo": _image(me)}
        self._save()
        self.error = ""
        log.info("Spotify 연결: %s", self.data["account"]["name"])
        return self.data["account"]

    async def finish_from_url(self, url: str) -> Dict[str, str]:
        """다른 컴퓨터에서 로그인해 127.0.0.1 로 못 돌아왔을 때: 그 창 주소를 붙여 넣는다"""
        q = parse_qs(urlparse(url.strip()).query)
        if q.get("error"):
            raise MusicError(f"Spotify 가 거절했습니다: {q['error'][0]}")
        if not q.get("code"):
            raise MusicError("주소에 code 가 없습니다. 로그인 뒤 열린 창의 주소 전체를 붙여 넣으세요")
        return await self.finish(q["code"][0], (q.get("state") or [""])[0])

    def disconnect(self) -> None:
        """로그인만 지운다 (앱 정보는 남긴다)"""
        for k in ("refresh_token", "access_token", "expires_at", "account"):
            self.data.pop(k, None)
        self._save()
        self.error = ""

    def status(self) -> Dict[str, Any]:
        return {"has_app": self.has_app, "client_id": self.data.get("client_id", ""), "connected": self.connected,
                "account": self.data.get("account") or {}, "error": self.error}

    # ---------- 토큰 ----------
    async def _token(self, form: Dict[str, str]) -> Dict[str, Any]:
        basic = base64.b64encode(f"{self.data['client_id']}:{self.data['client_secret']}".encode()).decode()
        r = await self._client.post(TOKEN_URL, data=form, headers={"Authorization": f"Basic {basic}"})
        if r.status_code != 200:
            raise MusicError(f"Spotify 로그인 실패 ({r.status_code}): {r.text[:200]}")
        return r.json()

    def _keep(self, tok: Dict[str, Any]) -> None:
        self.data["access_token"] = tok["access_token"]
        self.data["expires_at"] = time.time() + int(tok.get("expires_in", 3600)) - 60
        if tok.get("refresh_token"):
            self.data["refresh_token"] = tok["refresh_token"]   # 새로 주면 바꿔 둔다

    async def access_token(self) -> str:
        if not self.connected:
            raise MusicError("Spotify 계정이 연결되어 있지 않습니다")
        if self.data.get("access_token") and time.time() < self.data.get("expires_at", 0):
            return self.data["access_token"]
        try:
            self._keep(await self._token({"grant_type": "refresh_token", "refresh_token": self.data["refresh_token"]}))
        except MusicError as e:
            self.error = str(e)
            raise
        self._save()
        self.error = ""
        return self.data["access_token"]

    async def api(self, method: str, path: str, params: Optional[Dict] = None, body: Optional[Dict] = None) -> Any:
        token = await self.access_token()
        r = await self._client.request(method, API + path, params=params, json=body,
                                       headers={"Authorization": f"Bearer {token}"})
        if r.status_code == 204 or not r.content:
            return {}
        if r.status_code >= 400:
            try:
                msg = r.json().get("error", {}).get("message", r.text)
            except ValueError:
                msg = r.text
            if r.status_code == 403 and "premium" in msg.lower():
                msg = "Spotify Premium 계정이어야 재생할 수 있습니다"
            if r.status_code == 404 and path.startswith("/me/player"):
                msg = "음악을 틀 화면(Spotify 스피커)을 찾지 못했습니다. TV/관리자 화면이 켜져 있는지 보세요"
            raise MusicError(f"{msg} ({r.status_code})")
        return r.json()

    # ---------- 검색 · 목록 ----------
    async def search(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        r = await self.api("GET", "/search", {"q": query, "type": "track", "limit": min(limit, 10),
                                               "market": "from_token"})
        return [track_info(t) for t in (r.get("tracks") or {}).get("items") or [] if t]

    async def playlists(self) -> List[Dict[str, Any]]:
        r = await self.api("GET", "/me/playlists", {"limit": 50})
        out = []
        for p in r.get("items") or []:
            if not p:
                continue
            n = (p.get("items") or p.get("tracks") or {}).get("total")
            out.append({"id": p.get("id") or "", "uri": p.get("uri") or "", "title": p.get("name") or "",
                        "count": n, "image": _image(p),
                        "mine": (p.get("owner") or {}).get("id") == (self.data.get("account") or {}).get("id")})
        return out

    async def create_playlist(self, name: str, description: str = "") -> Dict[str, Any]:
        """내 재생목록 만들기 (비공개). 2026-03 부터 /users/{id}/playlists 대신 /me/playlists"""
        name = name.strip()
        if not name:
            raise MusicError("목록 이름을 넣으세요")
        p = await self.api("POST", "/me/playlists", body={"name": name, "public": False,
                                                          "description": description or "리본이와 듣는 노래"})
        return {"id": p.get("id") or "", "uri": p.get("uri") or "", "title": p.get("name") or name,
                "count": 0, "image": "", "mine": True}

    async def playlist_tracks(self, playlist_id: str, max_items: int = 500) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        offset = 0
        while offset < max_items:
            r = await self.api("GET", f"/playlists/{playlist_id}/items", {"limit": 100, "offset": offset})
            items = r.get("items") or []
            for it in items:
                t = it.get("item") or it.get("track")     # 2026-03 부터 item
                if t and t.get("uri"):
                    out.append(track_info(t))
            if not r.get("next"):
                break
            offset += len(items) or 100
        return out

    async def add(self, playlist_id: str, uris: List[str]) -> None:
        await self.api("POST", f"/playlists/{playlist_id}/items", body={"uris": uris})

    async def remove(self, playlist_id: str, uris: List[str]) -> None:
        await self.api("DELETE", f"/playlists/{playlist_id}/items", body={"items": [{"uri": u} for u in uris]})

    # ---------- 재생 (device_id = 재생 화면의 Web Playback SDK 장치) ----------
    async def play(self, device_id: str, uris: Optional[List[str]] = None, context_uri: str = "") -> None:
        body: Dict[str, Any] = {"uris": uris} if uris else {"context_uri": context_uri}
        await self.api("PUT", "/me/player/play", {"device_id": device_id}, body)

    async def resume(self, device_id: str) -> None:
        await self.api("PUT", "/me/player/play", {"device_id": device_id})

    async def pause(self, device_id: str) -> None:
        await self.api("PUT", "/me/player/pause", {"device_id": device_id})

    async def next(self, device_id: str) -> None:
        await self.api("POST", "/me/player/next", {"device_id": device_id})

    async def previous(self, device_id: str) -> None:
        await self.api("POST", "/me/player/previous", {"device_id": device_id})

    async def shuffle(self, device_id: str, on: bool) -> None:
        await self.api("PUT", "/me/player/shuffle", {"state": "true" if on else "false", "device_id": device_id})

    async def current(self) -> Optional[Dict[str, Any]]:
        r = await self.api("GET", "/me/player/currently-playing")
        t = r.get("item") if r else None
        return track_info(t) if t else None

    async def close(self) -> None:
        await self._client.aclose()
