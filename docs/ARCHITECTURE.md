# 아키텍처

## 운영 환경

- 장소: 미술학원. 한 타임 최대 4명, 5~10세. 선생님이 항상 함께 있다.
- 맥미니 M4 Pro 64GB: 서버. STT, LLM, TTS, 얼굴 식별, 그림 인식 전부 로컬.
- 노트북: TV에 HDMI 연결. 브라우저 전체화면으로 `?mode=tv`. DJI 수신기를 USB로 직결해 오디오를 서버로 보낸다.
- DJI Mic Mini: 아이별 무선 마이크. 스테레오 모드에서 송신기 두 개가 좌우 채널로 분리된다. 4명 = 2세트 = 4채널.
- 폰 1 (출입구): `?mode=entrance`. 카메라로 아이를 알아보고 그 자리에서 인사. 등원 기록.
- 웹캠 (맥미니, TV 위에 단다): 마이크처럼 맥미니에서 열어 둔 관리자 페이지가 직접 받는다 (`src/camera/facecam.ts`, MediaPipe Face Landmarker, 설정 탭에서 고르고 켜기·미리보기).
  얼굴 위치를 초당 10번 `face.positions` 로 보내고 서버가 TV 로 중계한다. TV 는 위치를 리본이 시선에, 얼굴 수를 "TV 앞에 누가 있나"에 쓴다. 영상은 관리자 브라우저 밖으로 나가지 않는다.
- (예전) 폰 2 (TV 위): `?mode=camera`. 같은 `face.positions` 를 보낸다.
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
| `ribbon/kids/profile.py` | 부르는 이름·생일 나이·다닌 기간 → 대화 프롬프트에 넣을 아이 정보 |
| `ribbon/schedule.py` | 수업 시간표: 정규 수업(아이별) + 그날만 옮긴 변경(`data/schedule.json`) |
| `ribbon/settings_store.py` | 관리자 설정 + 캐릭터별 프로필. 주인공 프로필을 RibbonConfig 로 복사 |
| `ribbon/world_store.py` | 3D 맵 배치(data/world/<방>.json)·TV 방·그림(data/artworks) 저장소, /api/world, /api/artworks |
| `ribbon/vision/faces.py` | 얼굴 식별 인터페이스 (3단계) |
| `ribbon/main.py` | FastAPI, WS 허브, 정적 서빙 |

## 클라이언트 모듈

| 파일 | 역할 |
|---|---|
| `src/main.ts` | mode 라우팅 |
| `src/ws.ts` | 재접속 WebSocket, 오디오 바이너리 전송 |
| `src/audio/capture.ts` + `public/pcm-worklet.js` | 마이크 → 채널별 16k PCM |
| `src/speech/browserTts.ts` | speak 재생 (브라우저 음성 또는 wav), 입 모양 레벨, tts.done |
| `src/world/types.ts` | 카탈로그·배치 형식 (Character_Creator 와 같음), 좌표 변환 |
| `src/world/room.ts` | 방 껍데기 + 가구 glb + 걸린 그림으로 3D 방 짓기 |
| `src/world/nav.ts` | 걸을 수 있는 바닥 격자, A* 길찾기 |
| `src/world/doll.ts` | 캐릭터 glb(ollie/seoyul) 읽기, 옷·색 적용 (TV·관리자·편집기 공용) |
| `src/tv/stage.ts` | three.js 렌더러·조명·TV 카메라, 화면 안에 보이는 바닥 판정 |
| `src/tv/ribbon3d.ts` | 리본이 몸: 걷기/인사 액션, 경로 따라 걷기, 고개·숨쉬기·말할 때 끄덕임 |
| `src/tv/brain.ts` | 리본이 행동: 돌아다니기·그림 구경, 부르면 멈춰 인사 후 "부르면 오는 자리"로 |
| `src/tv/hud.ts` | 대기 순서 칩, 자막 |
| `src/tv/index.ts` | 서버 메시지 → 화면 상태, 듣는 중/생각 중 말풍선 |
| `src/admin/index.ts` | 관리자 페이지 (탭: 대시보드 · 아이들 · 캐릭터 · 맵 · 설정). 휴대폰은 아래 탭 막대 |
| `src/admin/dashboard.ts`, `schedule.ts` | 캐릭터 조작·TV 방·지금 수업 아이들 / 시간표(일·주·월, 포인터로 끌어 옮기기 = 터치 가능) |
| `src/admin/kids.ts`, `characters.ts`, `map.ts`, `settings.ts` | 아이 인적사항·정규 수업 / 캐릭터 프로필(이력서) / 맵 편집기 (iframe) / 라이트·다크 |
| `src/editor/` | 맵 편집기 (Character_Creator 배치 편집기 이식본) |
| `src/debug/panel.ts` | 호출/발화/취소/등원 흉내, 마이크 장치 선택 |
| `src/entrance/index.ts` | 출입구 폰 골격 |
| `src/camera/facecam.ts` | 웹캠 얼굴 찾기 (관리자 페이지가 연다): 장치 기억·자동 켜기, 얼굴 위치 전송, 미리보기용 상자 |
| `src/camera/index.ts` | (예전) TV 위 폰 골격 |

## 대기열 규칙 (queue.py)

- `request(kid, ch)`: 줄에 없으면 추가. 활성 턴이 없으면 즉시 활성. 이미 있으면 그대로.
- `add_text(ch, text)`: 대기 중이든 활성이든 그 채널의 턴에 누적.
- `cancel(ch)`: 제거. 활성이었으면 다음 턴 승격.
- `complete_active()`: 끝내고 다음 승격. 다음 턴에 이미 텍스트가 있으면 바로 응답.
- `expire(now, timeout)`: 텍스트 없이 오래 기다린 대기 턴 제거.
- 활성 턴이 텍스트 없이 `turn_idle_timeout_s` 지나면 끝내고 다음으로.

## 그림 에셋

방·가구·리본이는 Character_Creator(블렌더)가 만든 glb (`client/public/world`, `tools/sync_world.py` 로 가져옴). 배치는 `data/world/<방>.json`. 자세한 내용은 `docs/WORLD.md`.

## 리본이 시선 (tv/brain.ts)

아이들은 화면에 없고 TV 앞에 있으므로, 대화 중에는 TV 카메라 쪽을 본다.

1. 불려서 대화 중: TV 위 카메라가 본 얼굴 중 화면 가운데에 가까운 얼굴 (`face.positions`), 없으면 TV 카메라
2. 평소: TV 쪽 / 정면 / 주변을 번갈아 두리번, 그림 앞에서는 그림

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
