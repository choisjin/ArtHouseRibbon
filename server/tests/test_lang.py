from ribbon.providers.tts import detect_lang


def test_korean_sentence():
    assert detect_lang("오늘 하루 어땠어?") == "ko"


def test_english_sentence():
    assert detect_lang("How was your day today?") == "en"


def test_korean_with_one_english_word_stays_korean():
    assert detect_lang("강아지는 영어로 dog 라고 해.") == "ko"


def test_mostly_english_with_a_korean_particle():
    assert detect_lang("Nice to meet you 야") == "en"
