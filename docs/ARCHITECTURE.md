# 아키텍처

## 운영 환경

- 장소: 미술학원. 한 타임 최대 4명, 5~10세. 선생님이 항상 함께 있다.
- 맥미니 M4 Pro 64GB: 서버. STT, LLM, TTS, 얼굴 식별, 그림 인식 전부 로컬.
- 노트북: TV에 HDMI 연결. 브라우저 전체화면으로 `?mode=tv`. DJI 수신기를 USB로 직결해 오디오를 서버로 보낸다.
- DJI Mic Mini: 아이별 무선 마이크. 스테레오 모드에서 송신기 두 개가 좌우 채널로 분리된다. 4명 = 2세트 = 4채널.
- 폰 1 (출입구): `?mode=entrance`. 카메라로 아이를 알아보고 그 자리에서 인사. 등원 기록.
- 폰 2 (TV 위): `?mode=camera`. 얼굴 위치를 보내 리본이 시선과 시차 효과에 쓴다.
- 놀고 있는 DSLR: 작품 촬영용 (4단계).

## 핵심 원칙

1. **채널이 곧 아이.** 누가 말했는지는 마이크 채널로 안다. 채널과 이름은 등원 때 얼굴 식별로 한 번 묶는다. 입 모양 같은 우회책은 필요 없다.
2. **순서 대기열.** 호출한 아이를 무시하지 않는다. 호출 즉시 녹음을 시작하고, 차례가 오면 아이가 다시 말하지 않아도 답한다. `내 말 취소` 로 뺀다.
3. **짧은 답.** 두세 문장. 대기열이 빨리 돌아야 한다.
4. **로컬 온리.** 얼굴은 벡터만 저장하고 사진은 저장하지 않는다. 대화 원본 녹음은 저장하지 않는다. 외부로 나가는 데이터가 없다.
5. **교체 가능한 제공자.** STT/LLM/TTS/호출어는 인터페이스 뒤에 있고 `.env` 로 고른다. `mock` 으로 모델 없이 전체 흐름이 돈다.

## 데이터 흐름

```
[노트북 브라우저]                      [맥미니 서버]
DJI 수신기 --getUserMedia(2ch)--> AudioWorklet --16k int16 20ms--> WS binary
                                                            |
                                              ChannelProcessor(채널별)
                                              idle: 호출어 감시
                                              listening: VAD 로 발화 분리 -> STT
                                                            |
                                              DialogueManager
                                              TurnQueue(호출/취소/만료)
                                              LLM 스트리밍 -> 문장 분할 -> TTS
                                                            |
TV 화면 <--WS JSON: state / ribbon.state / speak / transcript--
(browser TTS 면 speak.text 를 읽고 tts.done 회신, mac_say 면 wav base64 재생)
```

## 서버 모듈

| 파일 | 역할 |
|---|---|
| `ribbon/config.py` | `.env` 설정 |
| `ribbon/protocol.py` | 메시지 모델 |
| `ribbon/queue.py` | 순서 대기열 순수 로직 (테스트 대상) |
| `ribbon/dialogue.py` | 호출/발화 이벤트 → 대기열 → LLM → TTS → 다음 턴 |
| `ribbon/audio/stream.py` | 채널별 상태 기계 (idle/listening) |
| `ribbon/audio/vad.py` | 에너지 VAD + 발화 분리 |
| `ribbon/audio/wakeword.py` | 호출어 감지 (mock / openwakeword) |
| `ribbon/providers/*` | STT / LLM / TTS 제공자 |
| `ribbon/persona/ribbon.py` | 시스템 프롬프트와 고정 멘트 |
| `ribbon/kids/registry.py` | 아이 명단, 채널 배정, 출석 |
| `ribbon/room_store.py` | 방 배치 저장소 (data/room.json), /api/room |
| `ribbon/vision/faces.py` | 얼굴 식별 인터페이스 (3단계) |
| `ribbon/main.py` | FastAPI, WS 허브, 정적 서빙 |

## 클라이언트 모듈

| 파일 | 역할 |
|---|---|
| `src/main.ts` | mode 라우팅 |
| `src/ws.ts` | 재접속 WebSocket, 오디오 바이너리 전송 |
| `src/audio/capture.ts` + `public/pcm-worklet.js` | 마이크 → 채널별 16k PCM |
| `src/speech/browserTts.ts` | speak 재생 (브라우저 음성 또는 wav), 입 모양 레벨, tts.done |
| `src/tv/scene.ts` | Pixi Application + RoomView + 정수 배율 (내부 640x360) |
| `src/tv/room/spec.ts` | 방 구성 데이터 타입 (PNG 레이어, 앵커, 투시) |
| `src/tv/room/projection.ts` | 일점 투시 투영·역투영 (캐릭터 깊이 배율) |
| `src/tv/room/view.ts` | RoomSpec → 스프라이트 레이어 렌더링 (TV·관리자 공용) |
| `src/tv/ribbon.ts` | 리본이 픽셀아트 몸 + 코드가 그리는 눈·입(표정·시선·립싱크), 색조 필터 |
| `src/tv/avatar.ts` | 아이 아바타: 8방향 스프라이트 세트(걷기 애니메이션) 또는 조립식 도트, 손들기, 말풍선 |
| `src/tv/hud.ts` | 대기 순서 칩, 자막 |
| `src/tv/index.ts` | 서버 메시지 → 화면 상태 |
| `src/debug/panel.ts` | 호출/발화/취소/등원 흉내, 마이크 장치 선택 |
| `src/entrance/index.ts` | 출입구 폰 골격 |
| `src/camera/index.ts` | TV 위 폰 골격 |

## 대기열 규칙 (queue.py)

- `request(kid, ch)`: 줄에 없으면 추가. 활성 턴이 없으면 즉시 활성. 이미 있으면 그대로.
- `add_text(ch, text)`: 대기 중이든 활성이든 그 채널의 턴에 누적.
- `cancel(ch)`: 제거. 활성이었으면 다음 턴 승격.
- `complete_active()`: 끝내고 다음 승격. 다음 턴에 이미 텍스트가 있으면 바로 응답.
- `expire(now, timeout)`: 텍스트 없이 오래 기다린 대기 턴 제거.
- 활성 턴이 텍스트 없이 `turn_idle_timeout_s` 지나면 끝내고 다음으로.

## 그림 에셋

방 배경·가구·캐릭터는 PixelLab 으로 생성한 픽셀아트 PNG (`client/public/room`, `client/public/characters`). 배치는 `data/room.json`. 자세한 규격과 수정 방법은 `docs/ASSETS.md`.

## 리본이 시선 우선순위 (tv/index.ts)

1. 지금 상대하는 아이(`target_kid`)의 아바타 위치
2. TV 위 카메라가 본 얼굴 중 화면 가운데에 가까운 얼굴 (`face.positions`)
3. 아무도 없으면 천천히 두리번

## 호출어 "리본아"

기성 모델이 없으므로 openwakeword 커스텀 학습이 필요하다.

1. TTS(여러 음성, 속도, 피치)로 "리본아" 합성 음성 수천 개 + 비슷한 소리(리본, 이불아, 지본아 …) 부정 샘플 생성
2. 학원에서 실제 아이들 발화를 수십 개 녹음해 긍정 샘플에 섞는다 (합성 음성만으로는 아이 목소리 인식률이 낮다)
3. openwakeword 학습 노트북으로 `.onnx` 생성 → `RIBBON_WAKEWORD_MODEL_PATH`
4. 감지 문턱은 조금 낮게. 잘못 깨어나면 "응? 불렀어?" 로 가볍게 넘긴다.

학습 전에는 디버그 패널 `호출` 버튼, 또는 아이용 물리 버튼(노트북 USB)으로 대신할 수 있다.

## 맥미니 권장 모델

- LLM: Ollama `qwen3:30b-a3b` (MoE, 빠름, 한국어 양호) 또는 `gemma3:27b`. 그림 인식(4단계)까지 하나로 쓰려면 멀티모달 `qwen3-vl` 계열.
- STT: mlx-whisper `large-v3-turbo` (providers/stt.py 에 같은 인터페이스로 추가). 아이 발화는 인식률이 낮으니 자막으로 보여주고 되묻는 UX 유지.
- TTS: 우선 macOS `say -v Yuna`. 품질 올릴 때 MeloTTS(한국어) 또는 Kokoro 계열로 교체.
- 얼굴: insightface buffalo_l. 임베딩만 저장.

## 개인정보

- 얼굴 정보는 민감정보. 만 14세 미만은 법정대리인 동의 필수. 동의서에 "벡터만 저장, 외부 반출 없음" 명시.
- 카메라 설치 공간에 촬영 안내 표지.
- 대화 기록은 선생님 검토용으로만, 보관 기간을 정한다.
