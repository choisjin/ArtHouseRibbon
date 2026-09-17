# HANDOFF — 리본 프로젝트 (2026-09-18)

## 지금 상태

- 1단계(호출·순서 대기열 대화) 골격 완성, 맥미니에서 gemma3:27b + mlx-whisper + Supertonic 으로 실제 대화 확인 중.
- **TV 화면을 3D 로 전면 교체** (2026-09-18): Character_Creator(블렌더)의 방·가구·인형 glb + 배치 파일. 아이 아바타는 없앰.
  리본이는 방을 돌아다니다가 부르면 멈춰 인사하고 "부르면 오는 자리"로 옴. 자세한 것은 `docs/WORLD.md`.
- 관리자 페이지(`?mode=admin`): 아이(이름·나이·마이크), 리본이 목소리·겉모습(3D 미리보기)·돌아다니기, TV 에 보여줄 방.
- 맵 편집기(`?mode=editor`): Character_Creator 배치 편집기 이식. 서버 `/api/world`, `/api/artworks`, 저장하면 TV 즉시 반영.
- TV 배경은 블렌더 렌더 사진 (저장하면 맥미니 블렌더가 자동 렌더, `/api/world/render`). 리본이만 실시간, 가구 모델은 가림막.
  리본이 모델은 고화질(doll.blend 에서 메시당 24000면) + 천 재질 + 렌더와 같이 만든 HDR 조명. 인사는 오른손만.

## 실행

```
cd server && .venv\Scripts\activate && uvicorn ribbon.main:app --host 0.0.0.0 --port 8765
브라우저: http://localhost:8765/?mode=debug&demo=1   /   ?mode=admin
```

테스트: `cd server && pytest` (27개). 빌드: `cd client && npm run build`.

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
- 브라우저 오디오는 첫 클릭 전까지 잠김 → 화면 안내 표시.
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
