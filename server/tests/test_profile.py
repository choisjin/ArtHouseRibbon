import datetime as dt
import json

from ribbon.kids.profile import age_of, birthday_days, call_name, context_lines, months_since_start
from ribbon.persona.ribbon import build_messages
from ribbon.protocol import KidInfo
from ribbon.settings_store import ConfigStore

TODAY = dt.date(2026, 9, 21)


def test_call_name_prefers_nickname():
    assert call_name(KidInfo(id="a", name="하준")) == "하준"
    assert call_name(KidInfo(id="a", name="하준", nickname="준이")) == "준이"


def test_age_from_birthday_or_fallback():
    assert age_of(KidInfo(id="a", name="a", birthday="2019-09-22"), TODAY) == 6
    assert age_of(KidInfo(id="a", name="a", birthday="2019-09-21"), TODAY) == 7
    assert age_of(KidInfo(id="a", name="a", age=5), TODAY) == 5


def test_birthday_and_months():
    k = KidInfo(id="a", name="a", birthday="2019-09-21", start_date="2026-06-10")
    assert birthday_days(k, TODAY) == 0
    assert months_since_start(k, TODAY) == 3
    lines = "\n".join(context_lines(k, TODAY))
    assert "생일" in lines and "3달째" in lines


def test_prompt_contains_kid_details():
    k = KidInfo(id="a", name="하준", nickname="준이", likes="공룡", memo="수줍음이 많음")
    system = build_messages(k, [], "안녕")[0]["content"]
    assert "준이" in system and "공룡" in system and "수줍음이 많음" in system


def test_old_settings_move_into_character_profile(tmp_path):
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"ribbon": {"name": "리본", "voice": "F3", "pitch": 4, "character": "ribbon"}}),
                 encoding="utf-8")
    store = ConfigStore(p)
    assert store.config.characters["ribbon"].voice == "F3"
    assert {"ribbon", "ollie", "seoyul"} <= set(store.config.characters)


def test_switching_main_character_uses_its_profile(tmp_path):
    store = ConfigStore(tmp_path / "settings.json")
    store.update_character("seoyul", {"voice": "F4", "personality": "씩씩하다"})
    rc = store.update_ribbon({"character": "seoyul"})
    assert (rc.name, rc.voice, rc.persona_extra) == ("서율", "F4", "씩씩하다")
    # 다시 읽어도 그대로
    again = ConfigStore(tmp_path / "settings.json")
    assert again.config.ribbon.voice == "F4" and again.config.characters["ribbon"].voice == "F1"
