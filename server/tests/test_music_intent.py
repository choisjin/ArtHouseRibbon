"""말로 하는 음악 부탁 알아듣기 (music_intent.parse)"""
import pytest

from ribbon.music_intent import parse


@pytest.mark.parametrize("text,kind,query", [
    ("피카츄 노래 틀어줘", "play", "피카츄"),
    ("리본아, 아이유 좋은날 틀어 줘!", "play", "아이유 좋은날"),
    ("스포티파이에서 상어가족 틀어줘", "play", "상어가족"),
    ("포켓몬 주제가 재생해줘", "play", "포켓몬 주제가"),
    ("뽀로로 노래 들려줘", "play", "뽀로로"),
    ("노래 틀어줘", "play_list", ""),
    ("음악 좀 틀어 줘", "play_list", ""),
    ("스포티파이 켜줘", "play_list", ""),
    ("내 목록 틀어줘", "play_list", ""),
    ("내 플레이리스트 재생해줘", "play_list", ""),
    ("노래 꺼줘", "pause", ""),
    ("음악 멈춰", "pause", ""),
    ("노래 그만 틀어", "pause", ""),
    ("다시 틀어줘", "resume", ""),
    ("다음 노래", "next", ""),
    ("다른 노래 틀어줘", "next", ""),
    ("이거 넘겨줘", "next", ""),
    ("앞 노래로", "prev", ""),
    ("소리 좀 키워줘", "louder", ""),
    ("음악 소리 줄여줘", "quieter", ""),
    ("이 노래 내 목록에 넣어줘", "add", ""),
    ("이 노래 저장해줘", "add", ""),
    ("이 노래 목록에서 빼줘", "remove", ""),
    ("이 노래 지워줘", "remove", ""),
    ("이 노래 뭐야?", "what", ""),
    ("무슨 노래야", "what", ""),
])
def test_music_requests(text, kind, query):
    it = parse(text)
    assert it is not None, text
    assert (it.kind, it.query) == (kind, query)


@pytest.mark.parametrize("text", [
    "어제 노래 틀었어",
    "노래 불러줘",
    "재미있는 이야기 들려줘",
    "만화 틀어줘",
    "나는 노래 좋아해",
    "무슨 노래 좋아해?",
    "그만",
    "다음에 또 하자",
    "노래 끄지 마",
    "포켓몬 맞추기 하자",
    "TV 켜줘",
])
def test_not_music(text):
    assert parse(text) is None
