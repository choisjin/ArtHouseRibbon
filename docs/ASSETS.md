# 그림 에셋 안내

TV 화면의 방과 캐릭터는 전부 PNG 그림이고, 코드는 "어디에 놓을지"만 안다. 그림을 바꾸고 싶으면 PNG 를 고치면 되고,
위치를 바꾸고 싶으면 관리자 페이지 → 방 꾸미기에서 끌어서 옮기면 된다.

## 폴더

```
client/public/room/          방 배경과 가구 (git 에 포함)
  bg.png                     640x360 방 껍데기 (벽·바닥·창·문·빈 액자). 가구 없음
  table.png rug.png shelf.png easel.png easel2.png plant.png plant2.png poster.png
  manifest.json              생성에 쓴 PixelLab 엔드포인트·seed 기록
client/public/characters/    캐릭터
  ribbon.png                 리본이 몸 96x96. 얼굴은 비워 둔다 (눈·입은 코드가 그림)
  kid_<id>/                  아이 스프라이트 세트
    set.json                 {"idle": [방향...], "walk": {"south": 6, ...}, "frame": [64, 64]}
    idle_<방향>.png           정지 프레임 8방향 (south, south-west, west, north-west, north, north-east, east, south-east)
    walk_<방향>_<n>.png       걷기 프레임 (south/north/east/west, 0부터)
data/room.json               배치 (git 제외, 관리자 페이지가 씀). 기본값은 data/room.example.json
```

## 규격

| 에셋 | 크기 | 비고 |
|---|---|---|
| 방 배경 | 640×360, 불투명 | 내부 해상도. FHD TV 에서 3배로 확대되므로 픽셀 1개 = 화면 3픽셀 |
| 가구 | 자유, 투명 PNG | 원본 배율로 그린다. 확대해서 저장하지 말 것 (흐려짐) |
| 리본이 몸 | 96×96, 투명 | 발끝이 아래 가운데. 얼굴 자리 좌표는 `client/src/tv/ribbon.ts` 의 `RIBBON_FACE` |
| 아이 | 64×64, 투명 | 발끝이 아래 가운데. 8방향 정지 + 4방향 걷기 |

픽셀아트 규칙: 안티앨리어싱 없이, 1배율 그대로. Aseprite 에서 열어 색만 바꿔 같은 이름으로 저장하면 된다.

## 무엇을 고치면 무엇이 바뀌나

| 하고 싶은 것 | 방법 |
|---|---|
| 벽 색, 창문 모양, 바닥 무늬 | `room/bg.png` 를 그래픽 툴에서 수정 |
| 가구 위치·순서·보임 | 관리자 페이지 → 방 꾸미기에서 드래그, 저장 |
| 가구 그림 교체 | 방 꾸미기 → 레이어 선택 → "PNG 교체" 업로드 (또는 같은 이름으로 파일 덮어쓰기 후 `npm run build`) |
| 새 가구 | 방 꾸미기 → "PNG 로 가구 추가" |
| 아이 자리·입장 문·리본이 위치 | 방 꾸미기 → 앵커 편집 켜고 표식 드래그 |
| 리본이 색 | 관리자 페이지 → 리본이 → 몸 색 (그림의 색조를 돌린다) |
| 리본이 모양 자체 | `characters/ribbon.png` 교체 후 `RIBBON_FACE` 좌표 조정 |
| 아이 캐릭터 새로 만들기 | 아래 "PixelLab 으로 다시 만들기" |

## PixelLab 으로 다시 만들기

이 PC 에 `~/bin/pixellab.py` 가 설정되어 있다. 비용은 구독 생성 단위로 든다 (배경 Pro 40, 가구 Pro 20~25, 캐릭터 2, 걷기 4방향 4).

```bash
# 방 배경 (Pro)
python ~/bin/pixellab.py post generate-image-v2 -d '{"description":"16-bit pixel art one-point perspective art classroom ...","image_size":{"width":640,"height":360},"seed":11}' -o bg.png
# 가구 (투명, 배경 스타일 따라가기) - scratch 의 gen/prop.py 참고
# 아이 8방향
python ~/bin/pixellab.py post create-character-v3 -d '{"description":"16-bit pixel art cute 7 year old Korean girl ...","image_size":{"width":64,"height":64},"view":"side","no_background":true,"seed":101}'
# 걷기 (템플릿, 방향당 1)
python ~/bin/pixellab.py post characters/animations -d '{"character_id":"...","mode":"template","template_animation_id":"walk","directions":["south","east"]}'
# 결과 내려받기: GET /characters/{id}/zip (Authorization: Bearer $PIXELLAB_SECRET)
```

Pro 배경은 바닥 하이라이트를 투명으로 뚫어 내는 경우가 있다. `bg.png` 는 그 구멍을 바닥색으로 메운 것이다.
