# WebSocket 프로토콜 (`/ws`)

텍스트 프레임은 JSON, 오디오는 바이너리 프레임. 서버는 접속한 모든 클라이언트에 상태를 브로드캐스트한다
(`face.positions` 만 tv 역할에게만 중계).

## 클라이언트 → 서버

| type | 필드 | 보내는 쪽 | 설명 |
|---|---|---|---|
| `hello` | `role`: tv/entrance/camera/debug, `client_id` | 모두 | 접속 직후. 응답으로 `state` 스냅샷 |
| (binary) | `[channel u8][flags u8][int16 LE PCM 16kHz ...]` | tv | 채널별 20ms 프레임 (320 샘플) |
| `tts.done` | `utterance_id` | tv, entrance | speak 재생 완료. 서버가 다음 문장/턴으로 넘어감 |
| `debug.wake` | `channel` | debug | 호출어 감지 흉내 |
| `debug.utterance` | `channel`, `text` | debug | STT 결과 흉내 |
| `kid.enter` / `kid.leave` | `kid_id` | entrance, debug | 등원/하원 |
| `face.positions` | `faces: [{x, y, w, kid_id?}]` (0~1) | camera | TV 위 카메라가 본 얼굴 |

## 서버 → 클라이언트

| type | 필드 | 설명 |
|---|---|---|
| `state` | `kids[]`, `queue[]`, `ribbon`, `target_kid`, `config` | 전체 스냅샷. 변화가 있을 때마다. `config.ribbon` 은 관리자 설정, `config.room` 은 방 배치(RoomSpec) |
| `ribbon.state` | `state`: idle/listening/thinking/speaking, `target_kid` | 표정과 시선 |
| `speak` | `utterance_id`, `text`, `kid_id`, `audio_b64` (wav 또는 null), `final` | 읽을 문장. `audio_b64` 가 null 이면 클라이언트가 speechSynthesis 로 읽는다 |
| `transcript` | `kid_id`, `channel`, `text`, `final` | 아이가 한 말 (자막용) |
| `kid.enter` / `kid.leave` | `kid_id` | 입장/퇴장 연출 트리거. 곧이어 `state` 가 온다 |
| `face.positions` | camera 가 보낸 것 그대로 | tv 에게만 |

### KidInfo

```json
{"id": "kid_jiwoo", "name": "지우", "age": 7, "mic_channel": 0, "seat": 0,
 "avatar": {"hair": "short", "hair_color": "#3b2a1a", "skin": "#f2c9a0", "top": "#e74c3c"},
 "present": true}
```

### TurnInfo

```json
{"id": "t3", "kid_id": "kid_minsu", "channel": 1, "state": "waiting", "text": "내 그림 봐줘", "position": 1}
```

`position` 0 = 지금 대답 중, 1 = 다음.

## 한 턴의 흐름

```
tv  --binary audio ch0-->  server   (호출어 감지)
                           server --ribbon.state listening--> tv
                           server --speak "응 지우야, 말해봐"--> tv
tv  --tts.done-->          server
tv  --binary audio ch0-->  server   (VAD 발화 끝 -> STT)
                           server --transcript--> tv
                           server --ribbon.state thinking--> tv
                           server --speak (문장1, final=false)--> tv
tv  --tts.done-->          server
                           server --speak (문장2, final=true)--> tv
tv  --tts.done-->          server
                           server --state (다음 턴 활성 또는 idle)--> tv
```

다른 채널에서 호출이 겹치면 `speak "민수야, 지우 다음에 대답해줄게"` 가 끼어들고, `state.queue` 에 waiting 으로 나타난다.
