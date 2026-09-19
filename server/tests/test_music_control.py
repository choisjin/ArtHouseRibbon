"""말로 한 음악 부탁 -> Spotify 조작 (music_intent.MusicControl), 대화 흐름에 끼우기"""
from ribbon.music import MusicError
from ribbon.music_intent import MusicControl
from ribbon.settings_store import ConfigStore

from test_dialogue_flow import make, speaks


class FakeSpotify:
    connected = True

    def __init__(self):
        self.calls = []
        self.tracks = [{"uri": "spotify:track:1", "title": "피카츄 송", "artists": "지우", "album_art": "", "duration_ms": 1000}]
        self.list_tracks = []

    async def search(self, q, limit=5):
        self.calls.append(("search", q))
        return self.tracks

    async def play(self, device_id, uris=None, context_uri=""):
        self.calls.append(("play", device_id, tuple(uris or ()), context_uri))

    async def pause(self, device_id):
        self.calls.append(("pause", device_id))

    async def next(self, device_id):
        self.calls.append(("next", device_id))

    async def playlists(self):
        return [{"id": "p1", "uri": "spotify:playlist:p1", "title": "우리 노래", "mine": True}]

    async def playlist_tracks(self, pid):
        return self.list_tracks

    async def add(self, pid, uris):
        self.calls.append(("add", pid, tuple(uris)))

    async def remove(self, pid, uris):
        self.calls.append(("remove", pid, tuple(uris)))

    async def current(self):
        return None


def control(tmp_path, enabled=True):
    store = ConfigStore(tmp_path / "settings.json")
    store.update_music({"enabled": enabled})
    sp = FakeSpotify()
    mc = MusicControl(sp, store)
    mc.set_device("tv", "dev-tv")
    return mc, sp, store


async def test_off_means_normal_talk(tmp_path):
    mc, sp, _ = control(tmp_path, enabled=False)
    assert await mc.handle("피카츄 노래 틀어줘") is None


async def test_search_and_play_on_output_device(tmp_path):
    mc, sp, _ = control(tmp_path)
    assert await mc.handle("피카츄 노래 틀어줘") == ["피카츄 송, 틀어 줄게!"]
    assert ("search", "피카츄") in sp.calls
    assert ("play", "dev-tv", ("spotify:track:1",), "") in sp.calls


async def test_no_player_screen(tmp_path):
    mc, sp, store = control(tmp_path)
    store.update_music({"output": "admin"})          # 관리자 화면은 아직 스피커가 아니다
    lines = await mc.handle("피카츄 노래 틀어줘")
    assert lines == ["지금은 음악을 틀 수가 없어. 선생님께 말해 줘."]
    assert "관리자 화면" in mc.last_error


async def test_play_my_list_uses_first_own_playlist(tmp_path):
    mc, sp, _ = control(tmp_path)
    assert await mc.handle("내 목록 틀어줘") == ["우리 노래, 틀어 줄게!"]
    assert ("play", "dev-tv", (), "spotify:playlist:p1") in sp.calls


async def test_add_and_remove_current_track(tmp_path):
    mc, sp, _ = control(tmp_path)
    mc.set_state({"playing": True, "track": sp.tracks[0], "position_ms": 0})
    assert await mc.handle("이 노래 목록에 넣어줘") == ["피카츄 송, 목록에 넣었어!"]
    assert ("add", "p1", ("spotify:track:1",)) in sp.calls
    sp.list_tracks = sp.tracks
    assert await mc.handle("이 노래 넣어줘") == ["그 노래는 벌써 목록에 있어."]
    assert await mc.handle("이 노래 목록에서 빼줘") == ["피카츄 송, 목록에서 뺐어."]
    assert ("remove", "p1", ("spotify:track:1",)) in sp.calls
    assert ("next", "dev-tv") in sp.calls           # 뺀 노래는 넘긴다


async def test_music_talk_only_while_music_is_on(tmp_path):
    mc, sp, _ = control(tmp_path)
    assert await mc.handle("소리 줄여줘") is None    # 음악이 안 나오면 리본이 목소리 이야기일 수 있다
    mc.set_state({"playing": True, "track": sp.tracks[0], "position_ms": 0})
    assert await mc.handle("소리 줄여줘") == ["소리 줄였어."]
    assert mc.store.config.music.volume == 45
    assert await mc.handle("이 노래 뭐야") == ["지우의 피카츄 송이야."]


async def test_dialogue_answers_music_without_llm(tmp_path):
    dm, sent, llm = make()
    mc, sp, _ = control(tmp_path)
    dm.music = mc
    await dm.on_wake(0)
    await dm.on_utterance(0, "피카츄 노래 틀어줘")
    assert speaks(sent) == ["피카츄 송, 틀어 줄게!"]
    assert llm.heard == []
    assert dm.queue.active() is None
    await dm.on_utterance(0, "안녕")                 # 음악이 아닌 말은 보통 대화로
    assert llm.heard
