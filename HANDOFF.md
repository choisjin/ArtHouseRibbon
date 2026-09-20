# HANDOFF — 리본 프로젝트 (2026-09-19)

## 다음 대화에서 할 일: 대화 손보기 (사용자 요청 2026-09-19)

사용자 말 그대로:
> 리본이를 부르면 내가 한 말을 잘 들었는지 확인이 어려워서 또 말해서 대화가 겹치고 중첩된다.
> 리본이가 말이 너무 많다. 자꾸 뭘 물어보고 대화를 이끌어 가려고 해서 내가 하려던 말을 이어가지 못하고 자른다.
> 대화는 아이들이 주체가 되고 리본이는 보조하고 도와주는 역할만. **리본이는 놀이 상대.**

### 코드에서 찾은 원인 (확인한 것)
1. **이어 말한 뒷부분이 사라진다** — `dialogue._respond()` 는 시작하며 `turn.text = ""` 로 비우고, 생각하는 동안
   들어온 말은 `queue.add_text()` 로 같은 턴에 붙는다. 그런데 답이 끝나면 `queue.complete_active()` 가 그 턴을
   통째로 지워서 **뒷말이 버려진다**. 아이 입장에선 말을 잘린 것.
2. **말이 짧게 끊긴다** — `vad_silence_ms=800` (config.py). 아이들은 말 중간에 0.8초 넘게 쉬는 일이 많아
   앞부분만 먼저 LLM 으로 간다 → 1번과 겹쳐 "자른다"로 느껴진다.
3. **리본이가 말하는 동안은 마이크를 버린다** — `main.py:527` 에코 막기 `proc.hold()`. "응 ○○야, 말해봐." 가
   나오는 도중이나 끝난 뒤 0.7초 안에 말을 시작하면 그 말이 버려진다 → 아이가 다시 말한다 → 겹침.
4. **들었다는 신호가 늦다** — TV 자막(`tv/index.ts` transcript)은 STT 가 끝난 뒤에야 4초 뜬다.
   말하는 동안 "듣고 있어" 표시(마이크 음량 등)가 없다.
5. **말이 많다** — 한 턴에 말해봐 → 즉시 반응(ack: "'…' 라고 했지? 잠깐 생각해 볼게!") → 추임새 → 본 답(최대 3문장).
   시스템 프롬프트(`persona/ribbon.py`)가 질문을 부추긴다: "더 알고 싶은지 아이에게 되묻는다",
   "확실하지 않으면 … 아이에게 물어본다", "영어 단어, 숫자 세기, 한글 쓰기를 … 살짝 물어봐도 좋다".

### 2026-09-20 에 한 것
- 프롬프트를 "놀이 상대"로 다시 씀 (`persona/ribbon.py`): 아이가 주인공, 한두 문장, 기본은 질문 안 함, 화제 안 바꿈.
- 생각하는 중에 아이가 이어 말하면 LLM 을 멈추고 앞말+뒷말로 다시 생각 (최대 3번). 말하는 중에 들어온 말은
  같은 차례로 이어서 답함 → 뒷말을 버리지 않음 (`dialogue._respond`, 테스트 `test_dialogue_flow.py`).
- 부르면 기본은 "띵" 소리(`cue`) — 관리자 캐릭터 탭 "부르면"에서 목소리로 바꿀 수 있음. 기다리던 아이 차례엔 "○○야, 이제 네 차례야."
- 말 끝 판단 1.3초 (관리자에서 0.5~3초). 즉시 반응(ack)은 "응!" 처럼 짧게 + 기본 끔, 문장 수 기본 2.
  예전 settings.json 은 한 번 옮김 (`dialogue_style` 없으면 ack 끔·문장 2).
- TV: 들은 말 자막 8초. (👂 말풍선은 사용자 요청으로 없앰)
- **혼자 대화가 이어지던 문제** (맥미니 로그: 아무도 말 안 했는데 "다음 영상에서 만나요", "감사합니다"에 리본이가 계속 대답):
  Whisper 환각 문장·낮은 확신 구간 버리기(`stt.clean_segments`), 소리 큰 프레임 0.25초 미만은 잡음으로 버리기(`vad.py`),
  같은 말이 2.5초 안에 다른 채널에서도 들리면 버리기(`main._heard_elsewhere`), 리본이가 15초 안에 한 말과 겹치면 버리기
  (`dialogue._is_own_echo`). 캐릭터 성격 글을 그대로 읽은 일이 있어 "그대로 말하지 말라"고 프롬프트에 적음.
- 남은 것: 맥미니에서 실제로 써 보고 조용한 시간·프롬프트 조정. 말하는 도중 끼어들기(barge-in)는 아직.
- **약속 기억하기** (`server/ribbon/memory.py`, `data/memory.json`): 아이 말에 "하지 마·그만·싫어·불러줘·앞으로" 같은
  표현이 있으면 대답이 끝난 뒤 대화 모델에 한 번 더 물어 약속을 뽑는다(JSON). 아이별 20개(관리자 설정)·공통 30개, 한 약속 60자.
  다음 대화부터 시스템 프롬프트에 들어가고 "하지 말 것"이 항상 먼저. 안전 규칙을 푸는 약속은 버린다.
  관리자: 아이들 탭 "리본이와의 약속"(지우기·모두에게), 캐릭터 탭 "모든 아이와의 약속", 대시보드 대화 기록에 📝.
  모델을 학습(파인튜닝)하는 게 아니라 프롬프트에 넣는 기억이다.
- **호출 버튼** (`server/ribbon/audio/button.py`): DJI Mic Mini 송신기 버튼 = 수신기가 USB HID 로 볼륨 올림 [06 01 00].
  송신기 1·2번이 똑같고 누름 소리도 안 들어와서(`tools/hid_probe.py`, `button_channel_probe.py`) 누가 눌렀는지 모른다.
  그래서 버튼 -> "띵" -> 아이가 등록된 채널을 `button_window_s`(6초) 듣기 -> **먼저 말을 시작한 채널**이 부른 아이.
  서버가 수신기 HID 를 독점으로 열어서 맥 음량이 안 올라간다 (확인함). `pip install hidapi` 필요, 없으면 버튼만 꺼짐.
  맥에서 다른 프로그램(hid_probe 등)이 수신기를 열고 있으면 서버가 못 연다.
  버튼을 누르면 **하던 대화(말·생각·대기 줄)를 모두 멈추고** 새로 듣는다 (`dialogue.reset_for_button`).
- **음성 취소** (`persona.is_cancel`): "취소, 나중에 할게, 됐어, 안 할래, 잘못 불렀어, 이제 그만…" 이 말 전체일 때만
  (군말·리본 이름은 빼고 비교). "공룡 얘기 그만해" 같은 지적은 취소가 아님. 대답 중이면 멈추고 "알겠어 ○○야, 나중에 또 불러줘."
- **말로 깨우기 = 그 말을 그대로 받기**: energy/호출어로 깨어나면 띵·"말해봐"·줄 안내를 하지 않는다 (`on_wake(by_voice=True)`).
  전에는 띵 때문에 에코 막기가 마이크를 막아 깨운 말이 버려져서 "리본아" 를 먼저 해야 했다. 아이가 없는 채널은 말로 깨어나지 않는다.
- **포켓몬 도감** (`server/ribbon/knowledge/pokedex.py`): `python tools/fetch_pokedex.py` 로 PokeAPI 에서 1025마리 한국어 도감을
  `data/pokedex.json`(약 520KB, git 제외 - 도감 문장 저작권)으로 받는다. 아이 말에 이름이 나오면(자모 단위로 비슷한 이름도,
  "킹크랩" 같은 일상어는 "포켓몬" 이 같이 나올 때만) 그 정보를 시스템 프롬프트에 "참고 자료"로 넣고, 다음 두 번까지 이어 준다.
  관리자 캐릭터 탭에서 켜고 끈다. 같은 방식으로 공룡·동물 도감을 붙일 수 있다 (knowledge/ 폴더).
- **포켓몬 맞추기 게임** (`server/ribbon/games/pokemon_quiz.py`, TV `client/src/tv/game.ts`): 설명 듣고 / 그림 보고 /
  조금 보고 맞추기(6x6 중 4칸부터, 힌트마다 흩어진 5칸씩, 2026-09-20 "가린 그림" 에서 이름 바꿈). 한국어 이름 기준, 인식이 조금 틀려도 정답. **힌트는 달라고 할 때만**
  (틀리면 "아니야!"만). 힌트: 분류→생김새(대화 모델이 뒤에서 만듦)→키·몸무게→도감 문장(이름 가림)→진화→글자 수→초성→한 글자씩.
  정답 판정·힌트는 규칙 코드라 대화 모델을 거치지 않는다. 교실 전체가 같이(누가 말하든 답), 게임 중엔 이어 말하기 20초, 3분 조용하면 끝.
  **맞히면 묻지 않고 다음 문제로 이어 간다** (2026-09-20 요청 "종료하기 전까지"). 정답을 보여 주고 `QUIZ_NEXT_DELAY_S`(2초)
  쉰 뒤 `quiz.next_round()` -> "다음 문제!" (`dialogue._quiz_reply` 반복, phase `revealed`). 정답 알려줘·다음 문제·힌트가
  떨어졌을 때도 같다. 끝내려면 "그만/끝/안 할래"(정답 보여 주는 사이에도 받는다)·대시보드 중단·3분 조용.
  시작: "포켓몬 맞추기 하자"(셋 중 고르기) / 대시보드 버튼. 문제 범위: 캐릭터 탭 `game_max_id`(기본 151).
  그림: `/api/pokemon/{id}/image` 가 PokeAPI 공식 그림을 처음 한 번 받아 `data/pokemon_img/` 에 둔다.
  **게임 고르기 화면**: 아이가 하자고 하면 TV 에 타이틀 카드 3장(1·2·3번) -> 고르면 그 카드가 반짝이고 "이걸로 할까?" ->
  "응" 이면 시작, "아니/다른 거" 면 다시 고르기 (phase choosing -> confirm). 대시보드 버튼은 확인 없이 바로 시작.
  고르기 중에는 아이가 리본이가 읽어 준 게임 이름을 따라 말하므로 짧은 말은 에코로 버리지 않는다.
  썸네일: `python tools/make_game_thumbs.py` (mlx-serve 그림 모델 또는 mflux) -> `data/game_thumbs/`. 없으면 공식 그림
  (피카츄·이브이·팬텀). 집에서 아이와만 쓰므로 실제 포켓몬 그림을 쓴다 (사용자 결정).
  **표지 3장은 이 PC에서 mlx-media 스킬로 맥미니 MLX(Krea-2-Turbo, 768x1024)를 불러 만들어 `client/public/game_thumbs/*.jpg`
  로 저장소에 넣었다** (2026-09-20). 서버는 `data/game_thumbs/*.png`(맥미니에서 새로 만든 것) -> dist 의 jpg -> 공식 그림 순.
  **설명 듣고 맞추기가 너무 어렵다** (타입만 말함) -> 첫 문제 = 타입 + 분류 + **그림을 보고 만든 생김새 두 문장**, 나머지 생김새가
  첫 힌트들. 생김새는 `tools/make_pokemon_looks.py` 가 공식 그림을 그림 보는 대화 모델(맥미니 gemma-4-26b)에게 보여 주고 만든
  `server/ribbon/knowledge/pokemon_looks.json` (1~151번, 저장소에 들어감). 그 밖의 번호는 게임 중 그림을 보고 즉석으로 만들어
  `data/pokemon_looks_cache.json` 에 저장. 보통 대화의 도감 참고 자료에도 생김새가 들어간다.
  **놀자는 말로도 연다** (`detect_start`): 놀자·놀아줘·심심해·뭐 하고 놀까 / 게임·놀이·퀴즈·맞추기 + 하자·할래·해줘…
  "친구랑 게임했어", "놀이터 갔어" 같은 지난 이야기는 열지 않는다. 고르기에서 "아니, 소꿉놀이" 면 닫고 보통 대화로(passthrough).
  놀자는 말이면 **먼저 "포켓몬 맞추기 할까?"** (phase offer, TV 화면은 아직) -> 긍정이면 고르기 화면, 부정이면 "알겠어!"
  (다른 하고 싶은 말이 붙어 있으면 대화로). "포켓몬 맞추기 하자" 처럼 콕 집으면 바로 고르기 화면. 긍정/부정 낱말은
  `_YES_WORDS`/`_NO_WORDS` (부정이 먼저: "안 좋아" = 싫다) - 할까?·이걸로 할까?·하나 더 할래? 모두 같은 판단.
- 자기 목소리(에코) 판단: 리본이 문장의 60% 이상을 옮겼을 때만 (아이는 일부만 따라 말한다). 버튼 방식은 말이 끝난 뒤 3초만.
- **음성 인식 강화** (`providers/stt.py`): ① Whisper `initial_prompt` 에 아이 이름·별명·캐릭터 이름·자주 나오는 말,
  게임 중엔 게임 말 (`dialogue.stt_prompt`, 정답 포켓몬은 넣지 않음). 힌트를 길게(12자+) 그대로 읊으면 버림.
  ② 인식 전 소리 다듬기 `prepare`: 80Hz 아래 저음 줄이기 + 작은 목소리 키우기(최대 8배).
  ③ 캐릭터 탭 "아이 말 녹음 저장" -> `data/recordings/<날짜>/` wav + index.jsonl (git 제외).
  `python tools/stt_eval.py` 로 모델 비교 (large-v3-turbo vs large-v3-mlx, index.jsonl 의 correct 를 채우면 CER).
  더 나은 모델이면 `.env` 의 `RIBBON_STT_MODEL` 을 바꾼다.
  모델 이름은 `mlx_repo` 가 바꾼다 (large-v3 -> whisper-large-v3-mlx). 못 받으면 turbo 로 돌아간다.
- **끼어들기** (`audio/bargein.py`): 리본이가 말하는 동안(에코 막기 중)에도 채널별 최근 0.5초를 기억, `barge_in_rms`(기본 0.06)
  보다 큰 소리가 0.3초 이어지면 리본이를 멈추고(`dialogue.barge_in`) 그 소리부터 이어서 듣는다. 끼어든 뒤엔 리본이가
  다시 말할 때까지 에코 막기를 쉰다(`_barged`). 리본이가 한 번 말할 때마다 로그 "리본이 목소리가 마이크 N 에 들어온 크기"
  = 에코 크기 -> 기준은 그보다 넉넉히 크게 (캐릭터 탭).
- **입력 방식** `input_mode` (기본 **button**, 사용자 요청 2026-09-20 "모든 입력은 버튼을 누른 후에, 대기하지 마"):
  버튼(또는 대시보드 호출) 뒤 **말 한 번만** 받고 마이크를 닫는다 (`ChannelProcessor.single_shot`). 이어 말하기·말소리로 깨우기
  (`voice_wake`)·끼어들기는 끈다. 리본이가 말하는 중이면 버튼을 누르면 멈추고 듣는다. `auto` 로 바꾸면 예전처럼.
  버튼을 누르면 말은 하지 않고 바로 `button_window_s` 동안 듣는다 ("지금 말해줘" 는 2026-09-20 삭제).
  **말을 받을 수 있는 동안만 TV 오른쪽 위에 빨간 마이크** (`main._update_mic` -> `{"type":"mic"}`, 리본이가 말하는 중엔 꺼짐).
  추임새는 서버가 켜질 때·목소리를 바꿀 때 미리 합성해 둔다 (`dialogue.prewarm`, `_tts_cache`).
- **Spotify 음악** (2026-09-20, 사용자가 YouTube Music 대신 Spotify 로 결정): 관리자 설정 → 🎵 음악.
  Spotify 개발자 앱 Client ID/Secret(`data/spotify_auth.json`, git 제외, 상태 방송에 안 나감) -> "Spotify 로그인"(OAuth, 갱신 토큰).
  Redirect URI 는 `http://127.0.0.1:<포트>/api/music/callback` (Spotify 가 localhost 를 안 받음) -> **로그인은 맥미니 브라우저에서**,
  다른 PC 면 실패한 창 주소를 붙여 넣기. 앱 주인 Premium 필수, 개발 모드 5명, 재생목록 API 는 `/playlists/{id}/items`(2026-03 변경), 검색 10개까지.
  재생할 곳(TV 화면 / 관리자 페이지)이 Web Playback SDK 로 Spotify 스피커가 되고(`client/src/music/player.ts`, `music.device`),
  서버가 Web API 로 튼다(`server/ribbon/music.py`). 말은 규칙으로 알아듣는다(`music_intent.py`, 대화 모델 안 거침, 게임 중엔 안 봄):
  "피카츄 노래 틀어줘"(검색) · "내 목록 틀어줘" · 꺼줘 · 다시 · 다음/앞 노래 · 소리 키워/줄여 · 이 노래 넣어줘/빼줘(설정의 내 목록) · 이 노래 뭐야.
  소리·"뭐야"·앞 노래는 음악이 나올 때만 음악 이야기로 본다. 리본이가 말하거나 마이크가 켜지면 음악을 0.2배로 줄인다.
  TV 아래 상태바(`tv/musicbar.ts`, `music.state`), 멈춘 뒤 1분이면 내린다. 설정의 "시험" 칸 = `/api/music/command`.
  **"플레이리스트 보여줘"** -> TV 가운데에 번호 목록(`tv/musiclist.ts`, `music.list`, 한 쪽 6곡, 리본이가 번호와 제목을 읽어 준다)
  -> **번호를 말하면 그 곡을 목록에서 뺀다**. "다음"(다음 쪽) · "되돌려"(방금 뺀 곡을 원래 자리로) · "그만"(화면 내림).
  **검색 재생도 같은 번호 목록**(`kind` = search): 찾은 곡이 여럿이면 틀지 않고 보여 준 뒤 번호로 고르게 하고, **고른 한 곡만 튼다**
  (끝나도 다음 곡으로 안 넘어감, 사용자 요청 2026-09-20). 하나만 찾으면 바로 튼다.
  TV 상태바에 **반복·섞기·무엇을 틀고 있나**(🔎 찾은 노래 한 곡 / 📃 목록 이름)를 보여 준다: 재생 화면이 SDK 의
  `repeat_mode`·`shuffle`·`context.uri` 를 보내고 서버가 `source_info()` 로 이름을 붙인다. 말로도 바꾼다: "반복해줘"(목록 반복),
  "이 노래만 반복", "반복 꺼줘", "노래 섞어줘", "순서대로 틀어줘" (음악이 나오는 중에만 음악 이야기로 본다).
  음악과 상관없는 말이 오거나 3분 지나면 저절로 내린다 (`MusicControl.tick`). 설정에서 **새 목록 만들기**(비공개, 만들면 내 목록이 됨).
  **관리자 설정 → 🎵 음악 탭 한 장** (`client/src/admin/music.ts`, 2026-09-20 합침): 위에서부터 ① 플레이어(지금 곡·앞/재생·다음·
  반복·섞기·음량·재생할 곳, `/api/music/control`) ② 내 목록 고르기(= 리본이의 내 목록)·새 목록·다시 읽기·목록 틀기
  ③ 그 목록의 곡 ▶▲▼✕ ④ 타이핑 검색 → ▶ 들어보기 · ＋ 넣기 ⑤ 맨 아래 **⚙ 계정 · 설정 모달**(말로 부탁하기 켜기,
  Spotify 앱 정보·로그인, 시험 칸). API: `/api/music/playlist`, `/playlist/edit`, `/search`, `/play`, `/control`.
  여기서 고치면 TV 에 띄운 번호 목록도 같이 바뀐다 (`refresh_list`).
  순서 옮기기는 `PUT /playlists/{id}/items` (range_start·insert_before). 같은 곡이 목록에 두 번 있으면 빼기는 둘 다 지운다 (API 한계).
  **아직 실제 계정으로 확인 못 함** (앱·Premium 계정 필요). 맥미니에서 앱 만들고 로그인한 뒤 TV 에서 재생·조작 확인할 것.

- **폰으로 작품 찍어 보내기** (2026-09-20): `/?mode=snap` (`client/src/snap/index.ts`). 아이 고르기 -> 사진 찍기 -> 보내기
  -> `POST /api/artworks` (긴 변 2000px JPEG 로 줄여서). 벽에 거는 것은 `?mode=art` 그대로.
  관리자 설정 → 📷 카메라 탭 아래에 **QR 과 주소** (`GET /api/net` 이 랜 주소와 `RIBBON_PUBLIC_URL` 을 알려 준다, `qrcode` 패키지).
  **http 로는 폰 브라우저가 카메라를 막는다** -> 기본 카메라 앱을 여는 `<input capture>` 방식이 주 경로, https 면 화면 안 미리보기도 켠다.
- **밖에서 접속 · https** (`docs/REMOTE.md`, 사용자 결정 2026-09-20: 밖에서도 접속, DNS 는 Cloudflare):
  맥미니에 **Cloudflare Tunnel**(`cloudflared`) -> `ribbon.arthouseribbon.com` -> `localhost:8765`, 포트 개방 없음, 인증서는 Cloudflare.
  **Cloudflare Access(이메일 허용 목록)로 반드시 막을 것** — 서버에는 아직 로그인이 없다.
  `server/.env` 에 `RIBBON_PUBLIC_URL=https://ribbon.arthouseribbon.com` 을 넣으면 QR 주소와 **Spotify Redirect URI** 가 그 주소가 된다
  (Spotify 앱 설정에도 같은 주소를 넣어야 한다). `start_ribbon.command` 는 `--proxy-headers` 로 띄운다.

- **로그인 · 회원가입 · 권한** (2026-09-20 요청, `server/ribbon/auth.py` · `client/src/auth/index.ts`):
  `data/users.json`·`data/sessions.json`(둘 다 git 제외). 비밀번호는 pbkdf2-sha256 20만 번, 세션은 쿠키
  `ribbon_session`(60일, httponly). **첫 가입자가 자동으로 관리자**, 그 뒤는 `member`.
  서버 미들웨어가 막는다 (`auth.permitted`): 로그인 전 = 화면 파일과 `/api/auth/*` 만, member = 보기(state·kids·config·
  world·artworks·pokemon·game·tts/voices)와 작품 보내기(POST /api/artworks), **그 밖의 모든 `/api/` 는 admin 만**. WS 도 로그인 필요.
  아무도 가입하지 않았으면 전부 열려 있다 (첫 관리자를 만들 수 있게). 화면 쪽은 `main.ts` 가 열기 전에 `requireLogin()`,
  관리자·맵 편집기·전시실 꾸미기·디버그는 admin 이어야 열린다. 관리자 설정 → **👤 계정** 탭에서 권한 주기·지우기·내 비밀번호.
  마지막 관리자는 내리거나 지울 수 없다. 맥미니 TV·관리자 화면도 한 번은 로그인해야 한다 (쿠키 60일).

- **서율 새 디자인·동작 가져옴** (2026-09-20): `blender -b Character_Creator/seoyul.blend --factory-startup
  -P tools/blender/export_doll.py -- client/public/world/seoyul.glb` (또는 `python tools/sync_world.py --doll`).
  `doll_actions.build(keep_existing=True)` 로 바꿔서 **블렌더 파일에 이미 있는 동작은 덮어쓰지 않는다** —
  Character_Creator 가 캐릭터마다 만든 Walk·Greet·`make_sway` 의 Sway 가 그대로 실린다. 나머지(Nod·Shake·Tilt·Stretch·
  Point·Clap·Jump·LookUp·Peek·Sit)는 `doll_actions.py` 가 채운다. 서율은 Sway 가 블렌더 것, 리본이·올리는 아직 doll_actions 것.
- **관리자 페이지 = 리모컨** (사용자 설명 2026-09-20): TV 서버는 학원(맥미니)에서만 돌고, 폰은 리모컨으로 쓴다.
  `admin/index.ts isHostDevice()`: localhost 로 연 화면만 "학원 컴퓨터"로 보고 마이크·카메라 자동 시작과 Spotify 재생을 맡는다.
  폰·다른 컴퓨터에서 열면 그것들을 켜지 않는다 (설정 → 마이크·카메라 탭의 띠에서 바꿀 수 있다, `ctx.host`/`ctx.setHost`).
  음악 '재생할 곳'이 관리자 화면인데 리모컨에서 보고 있으면 경고를 띄운다. **폰 브라우저는 Spotify 스피커가 될 수 없다**
  (Web Playback SDK 가 모바일 미지원) -> 재생할 곳은 TV 화면으로 둔다.

- **리본이 인형은 뺐다** (2026-09-20 사용자 결정: "올리랑 서율이만 캐릭터로 사용"). 서비스 이름 "리본"은 그대로다
  (settings.json 의 `ribbon` 칸은 캐릭터가 아니라 공통 설정이다). `client/public/world/doll.glb` 삭제,
  `doll.ts CHARACTERS` 에서 ribbon 빼고 `DEFAULT_CHARACTER = "seoyul"`, 기본 옷 `apron`.
  서버는 `RibbonConfig.character` 기본값 seoyul, `DEFAULT_PROFILES` 에서 ribbon 뺌, `ConfigStore._drop_ribbon_character()`
  가 예전 설정을 한 번 옮긴다 (주인공/친구가 ribbon 이면 seoyul/빈 값으로, ribbon 프로필 삭제).
  **리본이 프로필에 손수 맞춰 둔 목소리·성격은 사라진다** (서율·올리 프로필을 쓴다). `sync_world.py --doll` 도 두 캐릭터만.

- **Spotify 앱 기기에서 틀기 (Connect)** (2026-09-20, 폰으로 TV 를 띄우려고): 관리자 → 음악 → 재생할 곳에
  **"Spotify 앱이 켜진 기기"** 추가 (`MusicConfig.output = "spotify"`, `device_id`/`device_name`).
  `GET /api/music/devices` 가 `/me/player/devices` 목록을 준다. 폰·태블릿 브라우저는 Web Playback SDK 를 못 써서
  (모바일 미지원) 그 기기의 **Spotify 앱**을 서버가 Connect 로 조종한다. 재생 상태는 브라우저가 알려 줄 수 없으므로
  서버가 4초마다 `/me/player` 를 물어 `music.state` 로 방송한다 (`MusicControl.poll`, `dialogue.tick`).
  리본이가 말하는 동안 음량 줄이기는 서버가 `/me/player/volume` 로 한다 (`MusicControl.duck`, `dialogue._set_ribbon`).
  "소리 키워/줄여" 도 Connect 기기 음량을 바꾼다. 앱이 꺼지면 기기 목록에서 사라지니 앱을 켜 두어야 한다.

- **TV 화면을 화면 가득** (2026-09-20): `client/src/tv/immersive.ts`. 첫 터치·클릭에서 전체화면(Fullscreen API)과
  화면 꺼짐 막기(Wake Lock)를 건다. 전체화면이 아니면 오른쪽 아래에 "⛶ 화면 가득" 단추. 폰에서 **홈 화면에 추가**로 열면
  (`client/public/manifest.webmanifest`, display fullscreen, start_url `/?mode=tv`) 처음부터 주소창 없이 뜬다.
  아이콘은 `python tools/make_icons.py` 가 만든다 (라이브러리 없이 PNG 를 직접 쓴다, 보라 배경 + 흰 리본).
  아이폰 사파리는 전체화면 API 가 없어서 "홈 화면에 추가" 로만 된다.

- **TV 화면에서 리본이 부르기** (2026-09-20, 폰으로 TV 를 띄우면서): `client/src/tv/callbutton.ts` 의 **오른쪽 기둥에 붙은 전등 스위치**(작은 단추, 말을 받는 동안 빨간 불)와
  엔터·스페이스·미디어 키 -> WS `tv.call` -> 서버가 **호출 버튼과 똑같이** 다룬다 (`main._on_button`, 1.5초 안의 연타는 한 번).
  **폰에 DJI 수신기를 꽂으면 버튼은 쓸 수 없다**: 수신기가 USB HID 로 "볼륨 올림" 키를 보내는데 맥미니에서는 서버가 그 장치를
  독점으로 열어 가로채지만(`audio/button.py`), 폰의 웹페이지는 USB 장치를 잡지 못해 그냥 폰 볼륨만 올라간다.
  블루투스 리모컨이 엔터·미디어 키를 보내면 그것도 호출로 받는다.

- **주소로 호출하기** `/api/call?token=...` (2026-09-20): 호출 버튼과 똑같이 동작한다 (`main.api_call` -> `_on_button`).
  로그인 대신 `ribbon.call_token`(처음 켤 때 저절로 만들어 settings.json 에 저장, 관리자 설정 → 마이크 탭에 주소가 나온다)으로
  확인한다. 폰에 DJI 수신기를 꽂았을 때 매크로 앱(MacroDroid·Tasker)이 **볼륨 올림 키**를 잡아 이 주소를 부르게 한다.
  **어느 송신기가 눌렀는지는 여전히 알 수 없다** (수신기가 둘 다 같은 HID 신호를 보낸다 - tools/hid_probe.py 로 확인).
  그래서 버튼 뒤 먼저 말한 채널을 부른 아이로 본다 (`audio/button.ButtonCall`).

- **폰을 TV 로 쓸 때 소리 출력 탭** (2026-09-20 확인): 폰·태블릿은 브라우저가 출력 장치 선택(setSinkId)을 지원하지 않고,
  "장치 이름 보기"(getUserMedia)는 NotAllowedError 로 막힌다. 그래서 TV 화면이 `mobile` 을 알려 주고
  (`tv/output.ts isMobile`), 관리자 설정 → TV 소리 탭이 그 경우 **장치 이름 보기 단추를 숨기고** 안내를 보여 준다.
  삐 소리는 **그 기기에서 TV 화면이 앞에 떠 있고 한 번 눌러 소리 잠금이 풀린 뒤에만** 난다 (브라우저 규칙).

- **폰에 마이크를 블루투스로 붙이면 소리가 안 난다** (2026-09-20 확인): 안드로이드는 블루투스 마이크를 쓰면
  통화 프로필(HFP/SCO)로 붙어 **출력까지 그 기기로 끌고 간다** — TV 소리가 마이크 쪽으로 가 버려 아무 데서도 안 들린다.
  소리 품질도 8~16kHz 로 떨어진다. -> **DJI 수신기는 USB-C 유선으로 꽂는다** (입력은 USB 오디오, 출력은 폰/HDMI 그대로).
  블루투스 기기의 재생/정지 버튼은 `navigator.mediaSession` 핸들러로 받아 호출로 쓴다 (`tv/callbutton.ts`,
  리본이가 한 번 말한 뒤부터 동작한다).

- **폰 한 대로 마이크와 소리를 같이 쓰기는 안 되는 기종이 있다** (2026-09-20 확인, 갤럭시):
  USB 수신기를 꽂으면 출력까지 USB 로 가 TV 소리가 사라지고, 개발자 옵션 "USB 오디오 주변기기로 자동 연결 사용 중지" 를 켜면
  소리는 돌아오지만 **마이크 장치가 목록에서 사라진다**. -> 역할을 나눈다: **폰 A = TV 화면(HDMI·소리), 폰 B = 마이크 수신기**.
  폰 B 는 **마이크 전용 화면 `/?mode=mic`** (`client/src/mic/index.ts`) 만 열어 두면 된다 — 장치 고르기·켜기·음량 막대뿐이고
  화면 꺼짐도 막는다 (`client/src/util/wakelock.ts`). 관리자 페이지 설정 → 마이크로도 같은 일을 할 수 있다 (host 모드).
  폰 A 는 개발자 옵션 "USB 오디오 주변기기로 자동 연결 사용 중지" 를 켜고, 폰 B 는 끈 채로 둔다.

- 멈추는 말을 넓혔다 (2026-09-20): 꺼·끄·멈춰·정지에 더해 **종료·중지·닫아·스톱·끝내**도 받는다
  ("스포티파이 종료"). Spotify 앱 기기(Connect)는 우리 상태가 몇 초 늦을 수 있어서, 안 나오는 것 같아도 한 번 멈춰 보고
  Spotify 가 "이미 멈춤"이라고 하면 "지금 나오는 노래가 없어." 로 답한다 (`_do_pause`).

### 처음 제안했던 방향
- 프롬프트를 "놀이 상대"로 다시 쓰기: 아이 말에 반응·맞장구·짧게 거들기, 1~2문장, **기본은 질문하지 않기**
  (아이가 물을 때만 답, 가끔 한 번만 되묻기), 화제 바꾸지 않기, 퀴즈·학습은 아이가 원할 때만.
- 생각하는 중(첫 소리 나기 전)에 아이가 더 말하면: LLM 을 멈추고 앞말+뒷말을 합쳐 다시 생각. 말하는 중이면 다음 답에 넘기기. 뒷말을 절대 버리지 않기.
- 말 끝 판단을 여유 있게 (0.8초 → 1.2~1.5초, 관리자 설정으로).
- 말로 하는 반응 줄이기: "말해봐"·ack 를 짧은 효과음(띵)이나 TV 표시로 바꾸는 선택지. 추임새도 줄이기.
- TV 에 "듣는 중" 표시(귀·마이크 음량 링)와 들은 말 자막을 더 오래.
- 무선 마이크가 아이 입 가까이 있으니 말하는 도중 끼어들기(barge-in)도 검토 — 에코 문턱을 높게.

## 이번 대화에서 한 것 (2026-09-19): 캐릭터 목소리
- TTS 비교(`tools/tts_bench.py`): 맥미니에서 대화 모델과 같이 돌리면 Qwen3-TTS 1.7B 첫 문장 3~5초, Chatterbox 14초
  → **Supertonic 유지**.
- Supertonic 목소리 섞기(음색 ttl / 말투 dp) + WORLD 아이 변환(`pyworld`, 음높이·울림 따로) → `server/ribbon/voices.py`
  프리셋. 관리자 캐릭터 탭 음성 칸에서 고른다. 샘플 만들기: `tools/voice_lab.py --set basic|kids|younger`.
- 아이 변환은 문장당 약 0.5초 더 걸린다. `pyworld` 는 `setuptools<81` 필요.


## 지금 상태

- 1단계(호출·순서 대기열 대화) 골격 완성, 맥미니에서 gemma3:27b + mlx-whisper + Supertonic 으로 실제 대화 확인 중.
- **TV 화면을 3D 로 전면 교체** (2026-09-18): Character_Creator(블렌더)의 방·가구·인형 glb + 배치 파일. 아이 아바타는 없앰.
  리본이는 방을 돌아다니다가 부르면 멈춰 인사하고 "부르면 오는 자리"로 옴. 자세한 것은 `docs/WORLD.md`.
- 관리자 페이지(`?mode=admin`): 아이(이름·나이·마이크), 리본이 목소리·겉모습(3D 미리보기)·돌아다니기, TV 에 보여줄 방.
- 마이크는 관리자 페이지가 보낸다 (설정 탭, `client/src/audio/mic.ts`: 장치 기억·자동 켜기·한 창만). 맥미니에서 관리자 페이지를 열어 둔다. `?mode=mic` 는 관리자 설정으로 넘어감.
- TV 소리 출력 장치는 관리자 설정 탭에서 원격으로 (TV 가 device.status 로 알리고 device.control 을 따름, `server/ribbon/devices.py`). start_ribbon 이 맥미니에서 마이크 화면을 연다.
- 맵 편집기(`?mode=editor`): Character_Creator 배치 편집기 이식. 서버 `/api/world`, `/api/artworks`, 저장하면 TV 즉시 반영.
- TV 배경은 블렌더 렌더 사진 (저장하면 맥미니 블렌더가 자동 렌더, `/api/world/render`). 리본이만 실시간, 가구 모델은 가림막.
  리본이 모델은 고화질(doll.blend 에서 메시당 24000면) + 천 재질 + 렌더와 같이 만든 HDR 조명. 인사는 오른손만.

## 실행

```
cd server && .venv\Scripts\activate && uvicorn ribbon.main:app --host 0.0.0.0 --port 8765
브라우저: http://localhost:8765/?mode=debug&demo=1   /   ?mode=admin
```

테스트: `cd server && pytest` (55개, `test_renderer_info_and_stale` 1개는 원래 실패). 빌드: `cd client && npm run build`.

## 다음 할 일

1. 맥미니에서 `git pull` + `cd client && npm install && npm run build`. 배치·그림은 git 에 없으니 맥미니에서 맵 편집기로 다시 놓거나 `data/world/`, `data/artworks/` 를 복사.
2. 맥미니 TV(실제 해상도)에서 리본이 크기·걷는 속도·돌아다니는 범위 확인. 인형 입이 안 움직이므로 필요하면 doll.py 에 입 벌림 모양(액션) 추가.
3. 2단계: TV 위 폰 얼굴 추적(MediaPipe) → `face.positions` → 리본이 시선. 코드 경로는 이미 있음.
4. 3단계: 출입구 폰 얼굴 식별(insightface) → `kid.enter` 자동화.
5. 4단계: 그림 걸기는 맵 편집기로 됨. 다음은 걸린 그림 보고 대화 (리본이가 그림 앞에 섰을 때 그 그림을 LLM 에 넘기기).
6. 호출어 "리본아" openwakeword 학습. 지금은 디버그 버튼.

## 알아둘 함정

- WS 수신 루프 안에서 대화 이벤트를 `await` 하면 교착 → `main.py` `_spawn`.
- 클라이언트 `RibbonSocket.on()` 은 늦게 등록된 핸들러에 마지막 `state` 를 재전달.
- 브라우저 오디오는 첫 클릭 전까지 잠김 → 화면 안내 표시 (TV 는 풀릴 때까지 "소리 켜기" 유지, 서버 창에 기록).
- **브라우저는 Chrome 기준.** Safari 에서는 소리가 안 나는 사례가 있고 출력 장치 선택(AudioContext.setSinkId)도 없다.
- 얼굴 조각(입·미간)은 Character_Creator `doll.py` 가 만든다. 입 구멍은 없애고 붙이는 조각으로 바꿨다 (2026-09-18).
- three.js 애니메이션 값이 지난 프레임과 같으면 씬에 다시 쓰지 않는다 → 뼈를 직접 건드리면 자세를 유지하는 동작이 풀린다.
  그래서 액션은 뼈 사본(`Ribbon3D.rig`)에서 돌리고 결과만 실제 뼈에 복사한다.
- doll.blend 의 뼈대는 DollSpot(방 속 위치) → DollMover(옆걸음) 아래에 있다. 내보낼 때 조상을 모두 원점으로 (`export_doll.py`). 안 그러면 몸이 발밑 그림자에서 떨어져 가구를 통과해 보인다.
- GLTFLoader 는 노드 이름의 점을 지운다: 블렌더 `arm.R` → three.js `armR` (트랙 이름도 `armR.quaternion`).
- 맥미니에 블렌더 설치 필요 (`brew install --cask blender`). 없으면 TV 는 실시간 3D 로 대신한다.
- doll.glb 액션은 모든 뼈를 키로 가진다 → 코드 움직임(고개 등)은 매 프레임 뼈를 쉬는 자세로 되돌리고 mixer.update 뒤에 얹는다 (`ribbon3d.ts`).
- 가구 모델은 캐시 복제본이라 기하·재질을 공유 → 다시 지을 때 가구는 dispose 하지 말 것 (`room.ts`).
- PixelLab 캐릭터 zip 은 두 번째 애니메이션 묶음이 `walking-<hash>/` 폴더로 들어옴 (glob `walking*`).
- `requirements*.txt` 는 ASCII 만 (Windows pip cp949).
- 운영 데이터 `data/kids.json`, `settings.json`, `world/`, `artworks/` 는 git 제외. 예제는 `*.example.json`.
- Character_Creator 의 layout_server.py 도 기본 포트 8765 → 리본 서버와 동시 실행 시 충돌.
- 편집기 `client/src/editor/app.js` 는 JS 그대로(타입 검사 밖). `app.d.ts` 로 import 만 통과시킴.
