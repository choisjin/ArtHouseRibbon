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
| `admin.wake` | `kid_id` (또는 `channel`) | admin | 관리자 호출. 그 아이 마이크로, 호출 무시 중에도 받는다 |
| `admin.stop` | `all` (bool) | admin | 중단: 하던 말·생각을 멈추고 다음 차례로. `all` 이면 대기열까지 비운다 |
| `admin.ignore` | `on` (bool) | admin | 호출 무시 켜기/끄기 (호출어와 새 말을 받지 않는다) |

## 서버 → 클라이언트

| type | 필드 | 설명 |
|---|---|---|
| `state` | `kids[]`, `queue[]`, `ribbon`, `target_kid`, `config`, `ignore_calls` | 전체 스냅샷. 변화가 있을 때마다. `config.ribbon` 은 주인공 설정(주인공 프로필이 복사됨), `config.characters` 는 캐릭터별 프로필, `config.world` 는 TV 방 |
| `ribbon.state` | `state`: idle/listening/thinking/speaking, `target_kid` | 표정과 시선 |
| `speak` | `utterance_id`, `text`, `kid_id`, `audio_b64` (wav 또는 null), `final` | 읽을 문장. `audio_b64` 가 null 이면 클라이언트가 speechSynthesis 로 읽는다 |
| `transcript` | `kid_id`, `channel`, `text`, `final` | 아이가 한 말 (자막용) |
| `kid.enter` / `kid.leave` | `kid_id` | 입장/퇴장 연출 트리거. 곧이어 `state` 가 온다 |
| `face.positions` | camera 가 보낸 것 그대로 | tv 에게만 |
| `speak.stop` | - | 관리자 중단. TV 는 재생 중인 소리와 남은 문장을 버린다 |
| `admin.msg` | `text`, `error` | 관리자 조작 결과 알림 (예: 마이크 없는 아이 호출) |

### KidInfo

```json
{"id": "kid_jiwoo", "name": "지우", "age": 7, "mic_channel": 0, "seat": 0, "avatar": {}, "present": true,
 "nickname": "지우니", "birthday": "2019-05-02", "start_date": "2026-03-02", "likes": "공룡", "memo": "",
 "schedule": [{"day": 0, "start": "15:00", "end": "16:30"}, {"day": 2, "start": "15:00", "end": "16:30"}]}
```

`schedule.day` 는 0=월 ... 4=금. 생일이 있으면 나이는 생일로 계산한다. 별명이 있으면 리본이가 별명으로 부른다.

### 시간표 REST

```
GET  /api/schedule?start=YYYY-MM-DD&end=YYYY-MM-DD   정규 수업 + 하루짜리 변경 (62일까지)
POST /api/schedule/move    {kid_id, orig_date, orig_start, date, start}   그날만 옮기기 (길이 그대로)
POST /api/schedule/cancel  {kid_id, orig_date, orig_start}                그날 결석
POST /api/schedule/restore {kid_id, orig_date, orig_start}                원래대로
PUT  /api/config/character/<id>  {name, intro, personality, voice, speed, steps, pitch, look}
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
