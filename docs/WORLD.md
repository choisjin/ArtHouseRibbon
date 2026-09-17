# 3D 맵과 리본이 (2026-09-18)

TV 화면은 **블렌더로 렌더한 방 사진 위에 three.js 로 리본이를 겹친 것**입니다. 방·가구·리본이 모델은 **Character_Creator**(블렌더, `E:/Project/Character_Creator`)에서 만들고, 이 프로젝트는 가져다 씁니다.
아이들은 화면에 그리지 않습니다. 리본이가 방을 돌아다니다가 부르면 반응합니다.

## 파일

| 위치 | 내용 | git |
|---|---|---|
| `client/public/world/doll.glb` | 리본이 (뼈대 + 원피스/투피스 + Walk/Greet 액션) | 포함 |
| `client/public/world/room_shell*.glb` | 방 껍데기 (미술실, 전시장) | 포함 |
| `client/public/world/catalog/*.glb`, `catalog.json` | 가구 종류, 방 크기·벽·기둥·TV 카메라, 기본 배치 | 포함 |
| `data/world/<방>.json` | 방별 가구 배치 + 걸린 그림 + 리본이 "부르면 오는 자리"(`doll_spot`) | 제외 |
| `data/world/world.json` | TV 에 보여줄 방 (`active`) | 제외 |
| `data/world/history/` | 저장 전 배치 (방마다 50개) | 제외 |
| `data/artworks/` | 올린 그림 + `index.json` | 제외 |
| `data/world/render/<방>.png`, `_env.hdr`, `.json` | TV 배경 렌더, 리본이 조명용 360° HDR, 렌더에 쓴 배치 | 제외 |
| `tools/blender/room_map.py`, `game_export.py` | Character_Creator 에서 복사한 방·가구 생성 코드 (고치지 말고 sync) | 포함 |
| `tools/blender/render_room.py` | 배치 → TV 배경 PNG + 환경 HDR 렌더 | 포함 |
| `tools/blender/export_doll.py` | doll.blend → 고화질 doll.glb (메시당 24000면까지) | 포함 |

배치 파일 형식은 Character_Creator 의 `layout.json` / `layout_gallery.json` 과 같습니다. 서로 복사해서 쓸 수 있습니다 (블렌더 렌더에도 그대로).

## 가져오기 / 갱신

```
python tools/sync_world.py                       # 모델·카탈로그·블렌더 스크립트
python tools/sync_world.py --doll                # + 인형 고화질 다시 내보내기 (Windows 블렌더)
python tools/sync_world.py --layouts --artworks  # 배치·그림까지 (기존 배치는 history 로 보관)
```

Character_Creator 에서 가구 모양이나 인형을 고쳤으면 그쪽에서 "블렌더 미리보기"(카탈로그 내보내기)를 한 번 한 뒤 위 명령을 다시 돌리고 `npm run build`.
경로가 다르면 `--src` 또는 환경변수 `CHARACTER_CREATOR`.

> Character_Creator 의 `tools/layout_server.py` 도 기본 포트가 8765 라서 리본 서버와 동시에 켜면 충돌합니다. 둘 중 하나를 `--port` 로 바꾸세요.

## TV 배경 렌더 (`server/ribbon/world_render.py`)

1. 맵 편집기에서 저장하면 서버가 그 방을 블렌더 헤드리스로 렌더한다 (`RIBBON_RENDER_AUTO`, 한 번에 하나, 렌더 중 또 저장하면 끝난 뒤 한 번 더).
   편집기의 "🎬 배경 렌더" 로 직접 돌릴 수도 있다. 서버를 켤 때 렌더가 없거나 옛 배치인 방도 렌더한다.
2. 결과: TV 시점 PNG (Cycles, AgX, 기본 1920x1080) + "부르면 오는 자리" 눈높이의 360° HDR.
3. TV 는 **렌더에 쓴 배치**로 가구 모델을 "깊이만 그리는 가림막"으로 두고(가구 뒤로 가면 가려짐),
   바닥에는 그림자만 받는 판을 깐다. 리본이는 HDR 환경광 + 천 재질(sheen), 톤매핑은 블렌더와 같은 AgX.
   카메라가 블렌더와 같아야 해서 화면은 16:9 고정 (남는 곳은 검은 띠).
4. 렌더가 끝나기 전까지 TV 는 옛 배경과 옛 배치 그대로. 블렌더가 없으면 방까지 실시간 3D 로 그린다.

## 정면 유리

TV 화면 위에 CSS 로 유리 느낌(테두리 빛, 모서리 반사, 대각선 반사 띠, 천천히 지나가는 광택)을 얹는다 (`index.html` `#glass`).
관리자 → 맵 카드에서 끄고 켜거나 세기를 바꾼다 (`settings.json` 의 `tv.glass`, `tv.glass_strength`).

## 편집

- 관리자 `?mode=admin` → "맵" 카드: TV 에 보여줄 방 선택, 맵 편집기 열기
- 맵 편집기 `?mode=editor#classroom` / `#gallery`: Character_Creator 배치 편집기를 옮겨 온 것 (`client/src/editor/app.js`). 사용법은 원본 README 와 같고, 블렌더 빌드 버튼 대신 "📺 TV 에 보여주기" 가 있습니다.
  - "리본이 자리" = 부르면 걸어오는 곳
  - 저장하면 그 방이 TV 에 나오는 중일 때 바로 반영
- 원본 편집기를 고치면 `client/src/editor/app.js` 에도 맞춰 주세요 (파일 맨 위에 바뀐 점 목록).

## 리본이 행동 (`client/src/tv/brain.ts`)

| 상황 | 행동 |
|---|---|
| 평소 | 방 안 빈 곳(가구·벽·기둥을 피하고 **몸 전체가 TV 화면에 보이는 곳**)으로 걸어가 잠깐 쉬기, 걸린 그림 앞에 가서 구경, 가끔 TV 쪽으로 손 흔들기 |
| 부름 (`ribbon.state` 가 idle 이 아니게 됨) | 그 자리에서 멈춤 → TV 쪽으로 돌기 → 손 흔들기(25초에 한 번) → "부르면 오는 자리"로 걸어옴 → TV 를 봄 |
| 듣는 중 / 생각 중 | 머리 위 👂 / 💭, 고개 갸웃. 카메라 폰이 얼굴을 보면 그 얼굴 쪽을 봄 |
| 말하는 중 | 음량에 맞춰 고개 끄덕임 (인형은 입이 움직이지 않음) |
| 인사 | Greet 액션에서 오른팔 트랙만 씀 (고개 갸웃·몸 흔들기 없이 손만 흔들기) |
| 대화 끝 | `return_after_s`(기본 8초) 뒤 다시 돌아다님 |

관리자 페이지에서 끌 수 있습니다: 돌아다니기(끄면 자리에 서 있음), 걷는 속도, 다시 돌아다니기까지 시간.
겉모습은 원피스/투피스와 머리·리본·원피스(치마)·블라우스 색 (`RibbonLook`, glb 재질 이름으로 찾음).

## 디버그

`?mode=debug&mute=1` 에서 콘솔의 `__ribbon` (`stage`, `ribbon`, `brain`) 로 위치·상태를 볼 수 있습니다. 디버그 패널의 "호출" 이 부름입니다.

## 옛 픽셀아트

2026-09-17 까지의 PixelLab 픽셀 방·아이 아바타·부위 조립 리본이와 생성 도구(chargen, ribbon_sprites)는 모두 지웠습니다. 커밋됐던 것은 git 기록에만 있습니다.
