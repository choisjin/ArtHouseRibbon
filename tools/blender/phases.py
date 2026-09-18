"""시간대(일출 → 아침 → 낮 → 일몰 → 밤)별 빛.

room_map.py(블렌더)와 리본 서버(world_render.py)가 같이 읽는다. 블렌더 없이도 불러올 수 있게
bpy 를 쓰지 않는 값만 둔다.

각 시간대의 값
  name      화면에 보여줄 이름
  from_h    이 시간(24시)부터 이 시간대 (다음 시간대 시작 전까지). 목록은 시간 순서
  sky       왼쪽 창으로 보이는 하늘빛 (방을 밝히는 환경광이기도 하다)
  sun       왼쪽 창으로 드는 햇빛 세기 / sun_color 그 색
  top       방 안에 퍼지는 빛(천장·앞쪽)의 배수
  panel     천장 매립 조명 밝기 배수 (낮에는 약하게, 밤에는 세게)
  exposure  렌더 노출(EV)
오른쪽은 상가 복도라 시간과 상관없이 늘 같은 밝기다.
"""

PHASES = {
    "dawn": dict(name="일출", from_h=5, sky=(0.30, 0.17, 0.22), sun=560, sun_color=(1.0, 0.66, 0.48),
                 top=0.32, panel=1.3, exposure=-0.6),
    "morning": dict(name="아침", from_h=7, sky=(0.50, 0.64, 0.86), sun=2000, sun_color=(1.0, 0.93, 0.86),
                    top=0.80, panel=0.7, exposure=-0.9),
    "day": dict(name="낮", from_h=11, sky=(0.46, 0.64, 0.90), sun=2600, sun_color=(1.0, 0.97, 0.92),
                top=1.0, panel=0.4, exposure=-0.9),
    "sunset": dict(name="일몰", from_h=17, sky=(0.62, 0.24, 0.09), sun=1300, sun_color=(1.0, 0.58, 0.34),
                   top=0.45, panel=1.2, exposure=-0.7),
    "night": dict(name="밤", from_h=20, sky=(0.018, 0.026, 0.06), sun=45, sun_color=(0.55, 0.62, 0.9),
                  top=0.12, panel=1.8, exposure=-0.65),
}

#: 시간 순서 (밤이 마지막이라 자정~새벽도 밤)
ORDER = ["dawn", "morning", "day", "sunset", "night"]
DEFAULT = "day"


def schedule():
    """[(시작 시각, 시간대 이름), ...] 시간 순서. TV 가 시계를 보고 고를 때 쓴다"""
    return [(PHASES[k]["from_h"], k) for k in ORDER]


def phase_of(hour):
    """24시 기준 시각(0~23) → 시간대 이름"""
    found = ORDER[-1]                     # 첫 시간대(일출) 전이면 밤
    for name in ORDER:
        if hour >= PHASES[name]["from_h"]:
            found = name
    return found


def get(phase):
    return PHASES.get(phase, PHASES[DEFAULT])
