from ribbon.dialogue import _SENTENCE_END


def split(text: str):
    return [s.strip() for s in _SENTENCE_END.split(text) if s.strip()]


def test_korean_endings_are_not_split_points():
    text = "무늬 덕분에 그림자에 숨어서 잘 보이지 않거든. 기린마다 무늬가 조금씩 다르대. 신기하지?"
    assert split(text) == ["무늬 덕분에 그림자에 숨어서 잘 보이지 않거든.", "기린마다 무늬가 조금씩 다르대.", "신기하지?"]


def test_split_on_punctuation_and_newline():
    assert split("안녕! 나는 리본이야.\n오늘은 뭐 그렸어?") == ["안녕!", "나는 리본이야.", "오늘은 뭐 그렸어?"]
