# HANDOFF — 리본 프로젝트 골격 (2026-09-15)

## 지금 상태

1단계 "호출 + 순서 대기열 대화" 골격이 모델 없이(mock) 끝까지 돈다. 브라우저에서 검증한 흐름:

- 등원(kid.enter) → 아바타가 문에서 걸어 들어와 자리에 앉고 리본이가 "지우 왔구나! 어서 와."
- 호출(채널 2) → "응 서연아, 말해봐." / 다른 채널 호출 → "하준아, 서연 다음에 대답해줄게." + 손 들기 + HUD 순서 표시
- 활성 턴 8초 무발화 → "서연아, 할 말 있으면 다시 불러줘." → 다음 턴 승격
- "내 말 취소" → "알겠어 하준아, 취소했어." → 대기열에서 제거
- 발화 → mock LLM 답변 → 문장 단위 speak → 브라우저 TTS → tts.done → 다음 턴

테스트: `cd server && pytest` (12개 통과). 빌드: `cd client && npm run build`.

## 실행

```
cd server && .venv\Scripts\activate && uvicorn ribbon.main:app --host 0.0.0.0 --port 8765
브라우저: http://localhost:8765/?mode=debug&demo=1   (client/dist 를 서버가 서빙)
개발 중 화면만 고칠 때: cd client && npm run dev  → http://localhost:5173/?mode=debug&demo=1
```

## 아직 안 된 것 / 다음 할 일

1. **실제 오디오 경로 미검증.** 디버그 패널 `마이크 시작` → AudioWorklet → WS 바이너리 → EnergyVAD → STT 까지 코드는 있지만 실제 마이크로 돌려보지 않았다. DJI Mic Mini 가 오면 스테레오 모드로 꽂고 채널 0/1 이 분리되는지, VAD 문턱(`RIBBON_VAD_RMS_THRESHOLD`)이 맞는지 확인.
2. **호출어 모델 없음.** `MockWakeWord` 라 호출은 디버그 버튼으로만. openwakeword "리본아" 학습 필요 (docs/ARCHITECTURE.md 참고). 임시로 물리 버튼/키보드 호출 경로를 붙여도 됨.
3. **맥미니 연결.** Ollama + `RIBBON_LLM_PROVIDER=openai`, mlx-whisper 제공자 추가(providers/stt.py), `RIBBON_TTS_PROVIDER=mac_say` 확인.
4. **2단계:** TV 위 폰 카메라 → MediaPipe 얼굴 위치 → `face.positions` (지금은 브라우저 FaceDetector 실험 API 있을 때만 동작). 리본이 시선 코드는 이미 그 메시지를 받는다.
5. **3단계:** 출입구 폰 얼굴 식별(insightface) → `kid.enter` 자동화 + 마이크 채널 자동 배정 (`KidRegistry.assign_channel`).
6. **화면 다듬기:** 리본이/아바타/방을 PixelLab 스프라이트로 교체, 벽 갤러리에 작품 걸기, 캐릭터 입장 애니메이션(문 열림).
7. 로그 출력이 Windows 콘솔에서 한글 깨짐 (cp949). 맥에서는 문제 없음. 필요하면 `PYTHONIOENCODING=utf-8`.

## 알아둘 함정

- WS 수신 루프 안에서 대화 이벤트를 `await` 하면 `tts.done` 을 못 받아 교착된다. `main.py` 의 `_spawn` 으로 분리해 둔 이유.
- 클라이언트 `RibbonSocket.on()` 은 핸들러 등록 전에 온 `state` 를 재전달한다 (화면 초기화가 WS 보다 느림).
- 브라우저 speechSynthesis 는 끝 이벤트가 안 올 수 있어 `browserTts.ts` 에 안전 타임아웃이 있다.
- 디버그 패널의 채널 select 는 아이 목록이 바뀔 때만 다시 그린다 (매번 그리면 선택이 0으로 돌아감).
- Pixi Container 에 `label` 속성이 이미 있어서 아바타 이름 텍스트는 `nameText`.
- `requirements*.txt` 는 ASCII 만 (Windows pip 이 cp949 로 읽음).
