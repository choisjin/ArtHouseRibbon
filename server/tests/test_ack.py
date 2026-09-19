from ribbon.persona.ribbon import acknowledge, filler


def test_math_request_is_acknowledged_as_math():
    a = acknowledge("수학 문제를 내줘", "지우")
    assert "수학" in a


def test_plain_talk_gets_short_reaction():
    a = acknowledge("기린이 좋아", "지우")
    assert len(a) <= 6          # 리본이 말이 많다는 의견: 아주 짧게만 받는다


def test_long_unknown_text_gets_default():
    a = acknowledge("어제 할머니 집에 가서 강아지랑 놀고 맛있는 것도 많이 먹었는데 정말 좋았어", "지우")
    assert a.endswith("!") or a.endswith("...") or a.endswith(".")


def test_fillers_rotate():
    assert filler(0) != filler(1)
    assert filler(5) == filler(0)
