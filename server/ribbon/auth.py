"""로그인 · 회원가입 · 권한 (data/users.json, data/sessions.json).

밖에서도 접속하므로(docs/REMOTE.md) 서버 자체에 문을 단다.
- **첫 계정은 자동으로 관리자**가 된다 (아직 아무도 없을 때 가입한 사람 = 원장 선생님).
- 그 뒤 가입한 사람은 `member`. 관리자가 관리 화면에서 `admin` 으로 올리거나 지운다.
- `member` 는 작품 찍어 보내기·전시실 보기 같은 것만, **관리 화면과 설정은 `admin` 만**.

비밀번호는 표준 라이브러리만으로 해시한다 (pbkdf2-sha256, 20만 번). 로그인하면 임의의 토큰을 쿠키에 담고
data/sessions.json 에 적어 둔다 (서버를 다시 켜도 로그인이 유지된다).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import re
import secrets
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger("ribbon.auth")

COOKIE = "ribbon_session"
SESSION_DAYS = 60
_ITER = 200_000
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


#: 로그인만 하면 되는 것 (member). 나머지 /api/ 는 모두 관리자만
MEMBER_GET = ("/api/state", "/api/kids", "/api/config", "/api/world", "/api/artworks", "/api/pokemon/",
              "/api/game/", "/api/tts/voices")
MEMBER_POST = ("/api/artworks",)          # 폰으로 작품 보내기


def permitted(path: str, method: str, role: Optional[str]) -> bool:
    """이 요청을 해도 되나. role 이 None 이면 로그인하지 않은 사람.
    화면 파일(/api/ 가 아닌 것)과 로그인 API 는 누구나 — 화면이 스스로 로그인 창을 띄운다"""
    if not path.startswith("/api/") or path.startswith("/api/auth/") or path == "/api/call":
        return True     # /api/call 은 호출 토큰으로 확인한다 (폰 매크로 앱이 부른다, main.api_call)
    if path.startswith("/api/share/") and method in ("GET", "HEAD"):
        return True     # 부모님께 보낸 전시실 주소: 주소 속 열쇠로 확인한다 (main.api_share)
    if role is None:
        return False
    if role == "admin":
        return True
    if path.endswith("/share"):
        return False    # 공유 주소를 만들고 보는 것은 관리자만 (/api/kids/<id>/share)
    if method in ("GET", "HEAD"):
        return any(path.startswith(p) for p in MEMBER_GET)
    return method == "POST" and path in MEMBER_POST


def hash_password(password: str, salt: Optional[bytes] = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _ITER)
    return f"pbkdf2${_ITER}${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, iters, salt_hex, digest_hex = stored.split("$")
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(iters))
    except (ValueError, TypeError):
        return False
    return secrets.compare_digest(digest.hex(), digest_hex)


def _now() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


class AuthStore:
    """계정과 로그인 세션. 파일 두 개로 관리한다 (아이 수십 명 규모라 DB 없이 충분하다)"""

    def __init__(self, users_path: Path, sessions_path: Path):
        self.users_path = users_path
        self.sessions_path = sessions_path
        self._lock = threading.Lock()
        self.users: List[Dict[str, Any]] = _read(users_path)
        self.sessions: Dict[str, Dict[str, Any]] = {s["token"]: s for s in _read(sessions_path)}
        self._drop_expired()

    # ---------- 계정 ----------
    @property
    def empty(self) -> bool:
        """아직 아무도 가입하지 않았다 -> 첫 가입자가 관리자가 된다"""
        return not self.users

    def find(self, email: str) -> Optional[Dict[str, Any]]:
        email = email.strip().lower()
        return next((u for u in self.users if u["email"] == email), None)

    def by_id(self, uid: str) -> Optional[Dict[str, Any]]:
        return next((u for u in self.users if u["id"] == uid), None)

    def signup(self, email: str, password: str, name: str) -> Dict[str, Any]:
        email, name = email.strip().lower(), name.strip()
        if not _EMAIL.match(email):
            raise ValueError("이메일 형식이 아닙니다")
        if len(password) < 8:
            raise ValueError("비밀번호는 8자 이상으로 해 주세요")
        if not name:
            raise ValueError("이름을 넣어 주세요")
        with self._lock:
            if self.find(email):
                raise ValueError("이미 가입한 이메일입니다")
            user = {"id": secrets.token_hex(8), "email": email, "name": name,
                    "password": hash_password(password),
                    "role": "admin" if self.empty else "member", "created": _now()}
            self.users.append(user)
            self._save_users()
        log.info("가입: %s (%s)", email, user["role"])
        return user

    def login(self, email: str, password: str) -> Dict[str, Any]:
        user = self.find(email)
        if user is None or not check_password(password, user["password"]):
            raise ValueError("이메일이나 비밀번호가 맞지 않습니다")
        return user

    def set_role(self, uid: str, role: str) -> Dict[str, Any]:
        if role not in ("admin", "member"):
            raise ValueError(f"모르는 권한입니다: {role}")
        with self._lock:
            user = self.by_id(uid)
            if user is None:
                raise ValueError("없는 계정입니다")
            if user["role"] == "admin" and role != "admin" and self._admin_count() <= 1:
                raise ValueError("관리자가 한 명뿐이라 권한을 내릴 수 없습니다")
            user["role"] = role
            self._save_users()
        return user

    def remove(self, uid: str) -> None:
        with self._lock:
            user = self.by_id(uid)
            if user is None:
                raise ValueError("없는 계정입니다")
            if user["role"] == "admin" and self._admin_count() <= 1:
                raise ValueError("마지막 관리자는 지울 수 없습니다")
            self.users = [u for u in self.users if u["id"] != uid]
            for token in [t for t, s in self.sessions.items() if s["user_id"] == uid]:
                del self.sessions[token]
            self._save_users()
            self._save_sessions()

    def set_password(self, uid: str, password: str) -> None:
        if len(password) < 8:
            raise ValueError("비밀번호는 8자 이상으로 해 주세요")
        with self._lock:
            user = self.by_id(uid)
            if user is None:
                raise ValueError("없는 계정입니다")
            user["password"] = hash_password(password)
            self._save_users()

    def _admin_count(self) -> int:
        return sum(1 for u in self.users if u["role"] == "admin")

    def public(self, user: Dict[str, Any]) -> Dict[str, Any]:
        """화면에 보내도 되는 것만 (비밀번호 해시는 절대 내보내지 않는다)"""
        return {k: user[k] for k in ("id", "email", "name", "role", "created") if k in user}

    def list_users(self) -> List[Dict[str, Any]]:
        return [self.public(u) for u in sorted(self.users, key=lambda u: u["created"])]

    # ---------- 세션 ----------
    def start_session(self, user: Dict[str, Any]) -> str:
        token = secrets.token_urlsafe(32)
        expires = dt.datetime.now() + dt.timedelta(days=SESSION_DAYS)
        with self._lock:
            self.sessions[token] = {"token": token, "user_id": user["id"], "created": _now(),
                                    "expires": expires.isoformat(timespec="seconds")}
            self._save_sessions()
        return token

    def user_for(self, token: Optional[str]) -> Optional[Dict[str, Any]]:
        if not token:
            return None
        s = self.sessions.get(token)
        if s is None:
            return None
        if dt.datetime.fromisoformat(s["expires"]) < dt.datetime.now():
            self.end_session(token)
            return None
        return self.by_id(s["user_id"])

    def end_session(self, token: Optional[str]) -> None:
        if not token:
            return
        with self._lock:
            if self.sessions.pop(token, None) is not None:
                self._save_sessions()

    def _drop_expired(self) -> None:
        now = dt.datetime.now()
        keep = {t: s for t, s in self.sessions.items() if dt.datetime.fromisoformat(s["expires"]) > now}
        if len(keep) != len(self.sessions):
            self.sessions = keep
            self._save_sessions()

    # ---------- 파일 ----------
    def _save_users(self) -> None:
        _write(self.users_path, self.users)

    def _save_sessions(self) -> None:
        _write(self.sessions_path, list(self.sessions.values()))


def _read(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:  # noqa: BLE001 - 깨진 파일이면 빈 목록으로 (로그인만 다시 하면 된다)
        log.warning("계정 파일을 읽지 못했습니다: %s", path)
        return []


def _write(path: Path, data: List[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
