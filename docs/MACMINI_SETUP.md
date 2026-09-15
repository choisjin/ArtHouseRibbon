# 맥미니 설치 순서

각 단계 끝의 "확인" 이 보이면 다음으로 넘어간다. 막히면 그 단계의 오류 메시지를 그대로 가져오면 된다.

## 0. 코드 위치

저장소: https://github.com/choisjin/ArtHouseRibbon (브랜치 `main`). Windows 작업 폴더 `E:/Project/kids_helper` 에서 푸시하고, 맥미니에서는 `~/ArtHouseRibbon` 으로 받는다.

이후 Windows 에서 고친 것을 맥미니에 반영할 때:

```bash
# Windows
cd E:/Project/kids_helper && git add -A && git commit -m "메시지" && git push
# 맥미니
cd ~/ArtHouseRibbon && git pull && (cd client && npm run build)
```

## 1. 기본 도구 (맥미니 터미널)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install python@3.12 node git
python3.12 --version && node --version
```

확인: Python 3.12.x, Node 20 이상.

## 2. Ollama 와 LLM 모델

```bash
brew install ollama
brew services start ollama
ollama pull qwen3:30b-a3b        # 약 19GB, 시간이 걸림
ollama run qwen3:30b-a3b "안녕, 한 문장으로 인사해줘"
```

확인: 한국어 답이 나온다. 그리고 아래가 모델 목록을 돌려준다.

```bash
curl -s http://localhost:11434/v1/models
```

## 3. 프로젝트 받기와 서버 설치

```bash
cd ~
git clone https://github.com/choisjin/ArtHouseRibbon.git
cd ArtHouseRibbon/server
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install mlx-whisper
pytest
```

확인: `12 passed`.

## 4. 클라이언트 빌드

```bash
cd ~/ArtHouseRibbon/client
npm install
npm run build
```

확인: `client/dist/index.html` 이 생긴다.

## 5. 한국어 음성 (TTS)

```bash
say -v '?' | grep ko_KR
```

`Yuna` 가 보이면 통과. 안 보이면 시스템 설정 → 손쉬운 사용 → 콘텐츠 말하기 → 시스템 음성 → 음성 관리 → 한국어 → Yuna 다운로드.

```bash
say -v Yuna "안녕, 나는 리본이야"
```

확인: 스피커에서 한국어가 나온다.

## 6. 설정 파일

```bash
cd ~/ArtHouseRibbon/server
cp .env.example .env
```

`.env` 에서 아래 네 줄만 바꾼다.

```
RIBBON_STT_PROVIDER=mlx_whisper
RIBBON_LLM_PROVIDER=openai
RIBBON_TTS_PROVIDER=mac_say
RIBBON_LLM_MODEL=qwen3:30b-a3b
```

STT 모델을 미리 내려받아 둔다 (약 1.6GB, 처음 한 번).

```bash
source .venv/bin/activate
python -c "import mlx_whisper, numpy as np; print(mlx_whisper.transcribe(np.zeros(16000, dtype='float32'), path_or_hf_repo='mlx-community/whisper-large-v3-turbo', language='ko')['text'])"
```

확인: 오류 없이 끝난다 (빈 문자열이 출력되면 정상).

## 7. 서버 실행과 맥 안에서 확인

```bash
cd ~/ArtHouseRibbon/server
source .venv/bin/activate
uvicorn ribbon.main:app --host 0.0.0.0 --port 8765
```

시작 로그에 `stt=mlx_whisper llm=openai tts=mac_say` 가 보여야 한다.

맥미니 브라우저(Safari 또는 Chrome)에서 `http://localhost:8765/?mode=debug&demo=1` 을 연다.

1. 아이들이 입장하고 리본이가 Yuna 목소리로 인사한다.
2. 채널 0 → `호출` → 입력창에 `내 그림에 고양이 그렸어` → `말하기`
3. 확인: 몇 초 안에 리본이가 실제 LLM 답을 두세 문장으로 말한다. 첫 답은 모델 로딩 때문에 느릴 수 있다.

## 8. 맥 내장 마이크로 STT 확인

같은 화면에서:

1. 마이크 장치 첫 번째 칸에 `MacBook/Mac mini Microphone` 선택 → `마이크 시작` (브라우저가 권한을 물으면 허용)
2. 채널 0 → `호출` 을 누른 뒤 마이크에 대고 한 문장 말하고 1초 조용히 한다.
3. 확인: 화면 아래에 `지우: (인식된 문장)` 자막이 뜨고 리본이가 답한다.

자막이 안 뜨면 서버 로그를 보고, 말소리를 못 자르는 것이면 `.env` 의 `RIBBON_VAD_RMS_THRESHOLD` 를 0.015 → 0.008 로 낮춘다. 반대로 조용한데도 계속 인식되면 0.03 으로 올린다.

## 9. 노트북에서 접속

맥미니 이름을 확인한다.

```bash
hostname
```

노트북 Chrome 에서 `http://<hostname>.local:8765/?mode=debug` 를 연다. 화면이 안 뜨면 맥미니 시스템 설정 → 네트워크 → 방화벽에서 Python 수신 허용, 또는 방화벽을 잠시 끈다.

노트북에서 마이크를 쓰려면 한 가지가 더 필요하다. 브라우저는 `localhost` 가 아닌 http 주소에서 마이크를 막는다.

1. Chrome 주소창에 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
2. 입력란에 `http://<hostname>.local:8765` 를 넣고 Enabled → Chrome 재시작

폰 카메라도 같은 이유로 같은 설정이 필요하다 (Android Chrome 은 같은 플래그, iPhone Safari 는 이 방법이 없어 나중에 HTTPS 를 붙인다).

## 10. 상시 운영 준비

```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 10
```

공유기에서 맥미니 IP 를 고정(DHCP 예약)해 둔다. 서버 자동 시작(launchd)은 마이크와 모델이 다 검증된 뒤에 붙인다.

## 자주 나는 문제

- `pip install mlx-whisper` 실패: Python 이 3.12 인지, 맥이 Apple Silicon 인지 확인. Intel 맥이면 `faster-whisper` 로 바꾼다.
- Ollama 응답이 너무 느림: `ollama ps` 로 모델이 GPU 에 올라갔는지 본다. 64GB 면 `qwen3:30b-a3b` 는 전부 올라간다.
- 리본이 답에 `<think>` 같은 생각 과정이 섞임: 서버가 걸러내지만, 그래도 나오면 `.env` 의 모델을 `gemma3:27b` 로 바꿔 본다.
- `say` 가 영어로 읽음: Yuna 가 설치되지 않은 것. 5단계 다시.
