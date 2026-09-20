"""로그인 · 회원가입 · 권한 (ribbon/auth.py)"""
import datetime as dt

import pytest

from ribbon.auth import AuthStore, check_password, hash_password, permitted


def store(tmp_path):
    return AuthStore(tmp_path / "users.json", tmp_path / "sessions.json")


def test_password_hash_is_salted_and_checkable():
    a, b = hash_password("같은비밀번호1234"), hash_password("같은비밀번호1234")
    assert a != b                                   # 소금이 달라 해시도 다르다
    assert check_password("같은비밀번호1234", a)
    assert not check_password("다른비밀번호", a)


def test_first_signup_becomes_admin(tmp_path):
    s = store(tmp_path)
    assert s.empty
    first = s.signup("won@art.com", "secret12345", "원장")
    second = s.signup("teacher@art.com", "secret12345", "선생님")
    assert first["role"] == "admin" and second["role"] == "member"
    assert not s.empty


def test_signup_checks(tmp_path):
    s = store(tmp_path)
    for email, pw, name, why in [("아니다", "secret12345", "이름", "이메일"),
                                 ("a@b.com", "짧다", "이름", "8자"),
                                 ("a@b.com", "secret12345", " ", "이름")]:
        with pytest.raises(ValueError) as e:
            s.signup(email, pw, name)
        assert why in str(e.value)
    s.signup("a@b.com", "secret12345", "이름")
    with pytest.raises(ValueError):
        s.signup("A@B.com", "secret12345", "다른 이름")      # 대소문자만 다른 같은 이메일


def test_login_and_session(tmp_path):
    s = store(tmp_path)
    user = s.signup("won@art.com", "secret12345", "원장")
    with pytest.raises(ValueError):
        s.login("won@art.com", "틀린비밀번호")
    token = s.start_session(s.login("WON@art.com", "secret12345"))   # 이메일 대소문자 구분 없음
    assert s.user_for(token)["id"] == user["id"]
    assert s.user_for("아무token") is None

    again = AuthStore(tmp_path / "users.json", tmp_path / "sessions.json")   # 서버를 다시 켜도 유지
    assert again.user_for(token)["email"] == "won@art.com"

    s.end_session(token)
    assert s.user_for(token) is None


def test_expired_session_is_dropped(tmp_path):
    s = store(tmp_path)
    user = s.signup("won@art.com", "secret12345", "원장")
    token = s.start_session(user)
    s.sessions[token]["expires"] = (dt.datetime.now() - dt.timedelta(days=1)).isoformat(timespec="seconds")
    assert s.user_for(token) is None


def test_last_admin_is_protected(tmp_path):
    s = store(tmp_path)
    boss = s.signup("won@art.com", "secret12345", "원장")
    teacher = s.signup("teacher@art.com", "secret12345", "선생님")
    with pytest.raises(ValueError):
        s.set_role(boss["id"], "member")            # 관리자가 한 명뿐
    with pytest.raises(ValueError):
        s.remove(boss["id"])
    s.set_role(teacher["id"], "admin")              # 선생님을 관리자로 올리면
    s.set_role(boss["id"], "member")                # 이제 내릴 수 있다
    assert s.by_id(boss["id"])["role"] == "member"


def test_public_hides_password(tmp_path):
    s = store(tmp_path)
    user = s.signup("won@art.com", "secret12345", "원장")
    pub = s.public(user)
    assert "password" not in pub and pub["email"] == "won@art.com"
    assert all("password" not in u for u in s.list_users())


@pytest.mark.parametrize("path,method,role,ok", [
    # 로그인하지 않은 사람: 화면 파일과 로그인 API 만
    ("/", "GET", None, True),
    ("/api/auth/login", "POST", None, True),
    ("/api/state", "GET", None, False),
    ("/api/config/ribbon", "PUT", None, False),
    # member: 보기와 작품 보내기까지
    ("/api/state", "GET", "member", True),
    ("/api/kids", "GET", "member", True),
    ("/api/artworks", "POST", "member", True),
    ("/api/kids", "POST", "member", False),          # 아이 추가는 관리자만
    ("/api/config/ribbon", "PUT", "member", False),
    ("/api/music/status", "GET", "member", False),
    ("/api/auth/users", "GET", "member", True),      # 관리자 확인은 엔드포인트 안에서 한 번 더
    # 부모님께 보낸 전시실 주소: 보기는 누구나(주소 속 열쇠로 확인), 주소를 만드는 것은 관리자만
    ("/api/share/abc123", "GET", None, True),
    ("/api/share/abc123", "POST", None, False),
    ("/api/kids/abc/share", "GET", "member", False),
    ("/api/kids/abc/share", "GET", "admin", True),
    # admin: 전부
    ("/api/config/ribbon", "PUT", "admin", True),
    ("/api/kids/abc", "DELETE", "admin", True),
])
def test_permission_rules(path, method, role, ok):
    assert permitted(path, method, role) is ok


def test_change_password(tmp_path):
    s = store(tmp_path)
    user = s.signup("won@art.com", "secret12345", "원장")
    s.set_password(user["id"], "newsecret123")
    assert s.login("won@art.com", "newsecret123")
    with pytest.raises(ValueError):
        s.set_password(user["id"], "짧음")
