# 리본 (Ribbon) — 미술학원 아이들과 대화하는 로컬 LLM 캐릭터

5~10세 아이들이 "리본아" 하고 부르면 순서대로 대답해 주는 TV 속 도트 캐릭터.
맥미니에서 모든 모델이 로컬로 돌아가고, 노트북이 TV에 화면을 띄우며, 폰 두 대가 출입구와 TV 위 카메라 역할을 한다.

설계 배경과 결정 사항은 `docs/ARCHITECTURE.md`, 메시지 규격은 `docs/PROTOCOL.md`.

## 구성

```
server/   FastAPI + WebSocket. 호출어 -> 대기열 -> LLM -> TTS (맥미니에서 실행)
client/   Vite + PixiJS 웹앱. ?mode=tv | entrance | camera | debug (노트북/폰 브라우저)
data/     kids.json (아이 명단), faces/ (얼굴 벡터, git 제외)
tools/    mic_test.py (무선 마이크 채널 분리 테스트)
docs/     설계 문서
```

## 빠른 시작 (모델 없이 흐름만 확인)

서버:

```bash
cd server
python -m venv .venv
# Windows: .venv\Scripts\activate  /  macOS: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # 기본값이 전부 mock 이라 그대로 두면 됨
uvicorn ribbon.main:app --host 0.0.0.0 --port 8765
```

클라이언트 (개발 서버):

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

브라우저에서 `http://localhost:5173/?mode=debug&demo=1` 을 열면
- 아이 네 명이 차례로 방에 입장하고
- 오른쪽 디버그 패널에서 채널을 고르고 `호출` → 문장 입력 → `말하기` 로 대기열 동작을 볼 수 있다.
- `d` 키로 패널을 숨기고 켠다.

TTS 는 기본이 브라우저 음성(speechSynthesis)이라 설치 없이 소리가 난다. 서버 콘솔에 호출/취소 로그가 찍힌다.

테스트:

```bash
cd server && pytest
```

## 실제 모델 연결 (맥미니)

1. Ollama 설치 후 `ollama pull qwen3:30b-a3b` (또는 `gemma3:27b`)
2. `pip install mlx-whisper` (호출어까지 쓰려면 `pip install -r requirements-models.txt`)
3. `.env` 에서
   ```
   RIBBON_LLM_PROVIDER=ollama
   RIBBON_STT_PROVIDER=mlx_whisper
   RIBBON_TTS_PROVIDER=mac_say
   ```
   자세한 순서는 `docs/MACMINI_SETUP.md`.
4. 호출어 모델("리본아")은 openwakeword 로 별도 학습 후 `RIBBON_WAKEWORD_PROVIDER=openwakeword`, 경로 지정. 학습 전에는 디버그 패널의 `호출` 버튼으로 대신한다.

배포 시에는 `cd client && npm run build` 로 만든 `client/dist` 를 서버가 `/` 에서 그대로 서빙하므로, 노트북과 폰은 `http://<맥미니IP>:8765/?mode=tv` 처럼 접속하면 된다.

## 마이크 (DJI Mic Mini)

- 수신기를 스테레오(S) 모드로 두면 송신기 1 = 왼쪽 = 채널 0, 송신기 2 = 오른쪽 = 채널 1.
- 두 번째 세트는 채널 2, 3. 디버그 패널에서 장치 두 개를 순서대로 고르면 된다.
- 브라우저 후처리(에코 제거 등)는 코드에서 꺼 두었다. 켜면 좌우가 섞인다.
- 갖고 있는 다른 무선 마이크의 채널 분리 여부는 `python tools/mic_test.py` 로 확인.

## 단계

1. 호출 + 대기열 대화 (이 골격) ← 지금
2. 도트 방 다듬기, TV 위 폰 얼굴 추적 → 리본이 시선 (MediaPipe)
3. 출입구 폰 얼굴 식별 → 입장 연출, 마이크 채널 자동 배정 (insightface)
4. 벽면 갤러리, 그림 보고 대화 (멀티모달 모델), 작품 아카이브·부모 전송
5. 아이가 그린 캐릭터를 아바타로 변환
