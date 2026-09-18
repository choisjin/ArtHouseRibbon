"""리본이 동작(액션) 만들기. export_doll.py 가 내보내기 전에 부른다.

doll.blend 에는 걷기(Walk)와 인사(Greet)만 있어서 할 수 있는 행동이 적다.
여기서 뼈대에 짧은 동작들을 더 만들어 glb 에 같이 넣는다 (블렌더 파일은 건드리지 않는다).

뼈대: pelvis → spine → head / arm.L / arm.R,  pelvis → leg.L / leg.R  (L/R 은 캐릭터 기준)
좌표: Z 위, 캐릭터 정면 = -Y. 회전은 뼈 머리 기준 아마추어 공간 (doll.py set_pose 와 같은 방식)
"""
import math

import bpy
from mathutils import Quaternion, Vector

FPS = 24
X, Y, Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)


def axis_rot(axis, ang):
    return Quaternion(Vector(axis), ang)


def set_pose(pb, rot=None, loc=None):
    """아마추어 공간 회전/이동을 포즈 로컬 값으로 (doll.py 와 같음)"""
    R = pb.bone.matrix_local.to_3x3()
    Rq = R.to_quaternion()
    pb.rotation_quaternion = Rq.inverted() @ (rot if rot is not None else Quaternion()) @ Rq
    pb.location = R.inverted() @ (loc if loc is not None else Vector())


def ease(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def bump(t):
    """0 → 1 → 0 (동작 하나의 세기)"""
    return math.sin(math.pi * min(1.0, max(0.0, t))) ** 0.8


def key_all(rig, f):
    for pb in rig.pose.bones:
        pb.keyframe_insert("location", frame=f)
        pb.keyframe_insert("rotation_quaternion", frame=f)


def rest(rig):
    for pb in rig.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.rotation_euler = (0, 0, 0)
        pb.scale = (1, 1, 1)


def make(rig, name, frames, fill):
    """frames 길이의 액션 하나. fill(pbs, t) 는 0~1 구간의 t 에 대해 포즈를 잡는다"""
    if rig.animation_data:
        rig.animation_data.action = None
    pbs = rig.pose.bones
    for f in range(1, frames + 1):
        rest(rig)
        fill(pbs, (f - 1) / (frames - 1))
        key_all(rig, f)
    act = rig.animation_data.action
    act.name = name
    act.use_fake_user = True
    rig.animation_data.action = None
    return act


# ---------- 동작들 ----------
def nod(pbs, t):
    """네 하고 끄덕이기 (두 번)"""
    a = math.radians(14) * math.sin(2 * math.pi * t * 2) * bump(t)
    set_pose(pbs["head"], axis_rot(X, a))
    set_pose(pbs["spine"], axis_rot(X, a * 0.25))


def shake(pbs, t):
    """아니야 하고 도리도리"""
    a = math.radians(18) * math.sin(2 * math.pi * t * 2) * bump(t)
    set_pose(pbs["head"], axis_rot(Z, a))


def tilt(pbs, t):
    """고개 갸웃 (궁금)"""
    k = bump(t)
    set_pose(pbs["head"], axis_rot(Y, math.radians(16) * k) @ axis_rot(X, math.radians(-4) * k))


def sway(pbs, t):
    """제자리에서 몸 좌우로 살랑 (심심할 때)"""
    k = bump(t)
    w = math.sin(2 * math.pi * t * 1.5)
    set_pose(pbs["spine"], axis_rot(Y, math.radians(7) * w * k))
    set_pose(pbs["head"], axis_rot(Y, math.radians(-5) * w * k))
    set_pose(pbs["arm.L"], axis_rot(Y, math.radians(-9) * w * k))
    set_pose(pbs["arm.R"], axis_rot(Y, math.radians(-9) * w * k))
    set_pose(pbs["pelvis"], None, Vector((0, 0, 0.02 * abs(w) * k)))


def stretch(pbs, t):
    """기지개: 두 팔을 앞쪽으로 크게 올려 만세.
    X 를 + 로 돌리면 팔이 몸 뒤로 가 큰 머리에 가려지므로 - (앞쪽)로 올리고 Z 로 벌린다"""
    k = bump(t)
    for side, sign in (("L", 1), ("R", -1)):
        set_pose(pbs[f"arm.{side}"],
                 axis_rot(Z, math.radians(45 * sign) * k) @ axis_rot(X, math.radians(-120) * k))
    set_pose(pbs["spine"], axis_rot(X, math.radians(-8) * k))
    set_pose(pbs["head"], axis_rot(X, math.radians(-10) * k))
    set_pose(pbs["pelvis"], None, Vector((0, 0, 0.05 * k)))


def point(pbs, t):
    """오른팔로 앞을 가리키고 잠깐 유지 (그림 앞에서). 정면에서도 보이게 바깥으로 조금 벌린다"""
    k = ease(t / 0.25) * (1 - ease((t - 0.75) / 0.25))
    set_pose(pbs["arm.R"], axis_rot(Z, math.radians(32) * k) @ axis_rot(X, math.radians(-72) * k))
    set_pose(pbs["spine"], axis_rot(Z, math.radians(-6) * k))
    set_pose(pbs["head"], axis_rot(X, math.radians(6) * k))


def clap(pbs, t):
    """박수 (반가울 때)"""
    k = bump(t)
    open_close = (math.sin(2 * math.pi * t * 4) * 0.5 + 0.5) * k
    for side, sign in (("L", -1), ("R", 1)):
        # 손이 몸 앞 가운데에서 만나도록 안쪽으로 모은다
        inward = math.radians(42 * sign) * (1 - 0.45 * open_close)
        set_pose(pbs[f"arm.{side}"], axis_rot(Z, inward) @ axis_rot(X, math.radians(-72) * k))
    set_pose(pbs["head"], axis_rot(X, math.radians(5) * k))
    set_pose(pbs["pelvis"], None, Vector((0, 0, 0.015 * open_close)))


def jump(pbs, t):
    """깡충 뛰며 기뻐하기 (두 번)"""
    h = abs(math.sin(2 * math.pi * t * 2)) * bump(t)
    set_pose(pbs["pelvis"], None, Vector((0, 0, 0.35 * h)))
    for side in ("L", "R"):
        set_pose(pbs[f"leg.{side}"], axis_rot(X, math.radians(-25) * h), Vector((0, 0, -0.06 * h)))
        set_pose(pbs[f"arm.{side}"], axis_rot(X, math.radians(-55) * h))
    set_pose(pbs["spine"], axis_rot(X, math.radians(-6) * h))


def look_up(pbs, t):
    """생각하는 듯 위를 보며 갸웃 (길게, 반복)"""
    k = bump(t)
    set_pose(pbs["head"], axis_rot(X, math.radians(-16) * k) @ axis_rot(Y, math.radians(9) * k))
    set_pose(pbs["spine"], axis_rot(X, math.radians(-3) * k))


def peek(pbs, t):
    """화면(유리) 코앞에 붙어 두 손을 짚고 들여다보기.
    팔을 앞(-X)으로 크게 올려 얼굴 옆에 두고, 몸을 앞으로 기울인다. 붙잡고 있는 동안 아주 조금 흔들린다"""
    k = ease(t / 0.16) * (1 - ease((t - 0.84) / 0.16))
    sway = math.sin(2 * math.pi * t * 1.5) * k
    for side, sign in (("L", 1), ("R", -1)):
        # 얼굴 옆으로 손을 올린다 (+X 로 돌리면 큰 머리 뒤로 가 안 보인다)
        set_pose(pbs[f"arm.{side}"],
                 axis_rot(Z, math.radians(30 * sign) * k) @ axis_rot(X, math.radians(-118) * k))
    set_pose(pbs["spine"], axis_rot(X, math.radians(-11) * k) @ axis_rot(Y, math.radians(2) * sway))
    set_pose(pbs["head"], axis_rot(X, math.radians(7) * k) @ axis_rot(Y, math.radians(-3) * sway))
    # 앞(-Y)으로 조금 기대고 까치발 들 듯 살짝 오르내린다
    set_pose(pbs["pelvis"], None, Vector((0, -0.08 * k, 0.012 * abs(sway))))


def sit(pbs, t):
    """의자에 앉아 있기 (반복). 몸통 위치는 코드가 좌판 높이에 맞추고, 여기서는 다리·팔 자세와 숨쉬기만"""
    b = math.sin(2 * math.pi * t)                     # 끝과 처음이 이어지도록 한 바퀴
    for side, sign in (("L", 1), ("R", -1)):
        # 다리는 좌판 앞으로 살짝 내밀어 대롱대롱
        set_pose(pbs[f"leg.{side}"], axis_rot(X, math.radians(-14 + 4 * b * sign)))
        # 팔은 몸 옆에서 조금 뒤로 (좌판을 짚은 느낌)
        set_pose(pbs[f"arm.{side}"], axis_rot(X, math.radians(16)) @ axis_rot(Y, math.radians(6 * sign)))
    set_pose(pbs["spine"], axis_rot(X, math.radians(4 + 1.5 * b)))
    set_pose(pbs["head"], axis_rot(X, math.radians(-3 - 1.5 * b)))
    set_pose(pbs["pelvis"], None, Vector((0, 0, 0.01 * b)))


ACTIONS = [
    ("Nod", 30, nod),
    ("Shake", 30, shake),
    ("Tilt", 36, tilt),
    ("Sway", 72, sway),
    ("Stretch", 60, stretch),
    ("Point", 72, point),
    ("Clap", 48, clap),
    ("Jump", 48, jump),
    ("LookUp", 60, look_up),
    ("Peek", 120, peek),       # 화면에 붙어 들여다보기 (오래 붙잡고 있는다)
    ("Sit", 96, sit),          # 반복해서 트는 동작 (TV 가 loop 로 재생)
]


def build(rig):
    """뼈대에 동작들을 만들어 넣는다. 이미 있는 같은 이름 액션은 지운다"""
    made = []
    for name, frames, fill in ACTIONS:
        old = bpy.data.actions.get(name)
        if old:
            bpy.data.actions.remove(old)
        made.append(make(rig, name, frames, fill).name)
    rest(rig)
    bpy.context.view_layer.update()
    print(f"[doll] 동작 추가: {', '.join(made)}")
    return made
