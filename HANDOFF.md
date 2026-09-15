# HANDOFF — 리본 프로젝트 (2026-09-16)

## 지금 상태

- 1단계(호출·순서 대기열 대화) 골격 완성, 맥미니에서 gemma3:27b + mlx-whisper + Supertonic 으로 실제 대화 확인 중.
- 관리자 페이지(`?mode=admin`): 아이·리본이 설정, 목소리 미리 듣기(속도·품질·피치), **방 꾸미기**(가구 드래그, 앵커 편집, PNG 추가/교체).
- 방과 캐릭터는 **PixelLab 으로 생성한 픽셀아트 PNG** 로 교체됨 (내부 해상도 640x360). 방 배경 1장, 가구 8종, 리본이 몸, 아이 4명 8방향 + 걷기 4방향. 규격·재생성 방법은 `docs/ASSETS.md`.
- 서버 `/api/room` (GET/PUT/reset), `state.config.room` 으로 TV 실시간 반영.

## 실행

```
cd server && .venv\Scripts\activate && uvicorn ribbon.main:app --host 0.0.0.0 --port 8765
브라우저: http://localhost:8765/?mode=debug&demo=1   /   ?mode=admin
```

테스트: `cd server && pytest` (12개). 빌드: `cd client && npm run build`.

## 다음 할 일

1. 맥미니에서 `git pull` + `npm run build` 후 새 방 확인. `data/kids.json` 에 `avatar.sprite_set` 이 없으면 관리자 페이지에서 아이별로 `kid_jiwoo` 등 입력 (예제는 들어 있음).
2. 실제 아이 이름·외모로 캐릭터 재생성 (`docs/ASSETS.md` 의 PixelLab 절차). 관리자 페이지에서 "AI 아바타 생성" 버튼으로 만들려면 서버에 PixelLab 키를 두고 `/api/kids/{id}/generate` 를 추가하면 됨.
3. 2단계: TV 위 폰 얼굴 추적(MediaPipe) → `face.positions` → 리본이 시선. 코드 경로는 이미 있음.
4. 3단계: 출입구 폰 얼굴 식별(insightface) → `kid.enter` 자동화.
5. 4단계: 벽 액자(`room.frameSlots`)에 작품 사진 걸기, 그림 보고 대화.
6. 호출어 "리본아" openwakeword 학습. 지금은 디버그 버튼.

## 알아둘 함정

- WS 수신 루프 안에서 대화 이벤트를 `await` 하면 교착 → `main.py` `_spawn`.
- 클라이언트 `RibbonSocket.on()` 은 늦게 등록된 핸들러에 마지막 `state` 를 재전달.
- 브라우저 오디오는 첫 클릭 전까지 잠김 → 화면 안내 표시.
- Pixi v8: 드래그 이동은 `globalpointermove` 를 써야 포인터가 객체를 벗어나도 따라온다. `hitArea` 는 stage 로컬 단위(640x360).
- Pixi `Container.label` 은 예약 속성 → 아바타 이름 텍스트는 `nameText`.
- PixelLab 캐릭터 zip 은 두 번째 애니메이션 묶음이 `walking-<hash>/` 폴더로 들어옴 (glob `walking*`).
- `requirements*.txt` 는 ASCII 만 (Windows pip cp949).
- 운영 데이터 `data/kids.json`, `settings.json`, `room.json`, `assets/` 는 git 제외. 예제는 `*.example.json`.
