"""인형 캐릭터를 고화질로 다시 내보낸다 (Character_Creator/<캐릭터>.blend → client/public/world/<캐릭터>.glb)

    blender -b <Character_Creator>/doll.blend --factory-startup -P tools/blender/export_doll.py -- [out.glb] [면 상한]
    blender -b <Character_Creator>/yoon.blend --factory-startup -P tools/blender/export_doll.py -- .../ollie.glb

캐릭터 스크립트(doll.py / yoon.py)의 기본 내보내기는 메시당 최대 5000면으로 줄여서 머리카락·옷이 뭉툭하다.
여기서는 상한을 크게(기본 24000면) 잡아 모양을 살리고, doll_actions.py 의 동작들(끄덕임·가리키기 등)을 더해 내보낸다.
뼈대 이름은 캐릭터마다 다르므로(DollRig / YoonRig / SeoyulRig) 파일 안의 아마추어를 찾아 쓴다. 블렌더 파일은 저장하지 않는다.
"""
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import doll_actions  # noqa: E402
import game_export  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = argv[0] if argv else os.path.join(ROOT, "client", "public", "world", "seoyul.glb")
CAP = int(argv[1]) if len(argv) > 1 else 24000

# 작은 부품은 그대로, 큰 부품만 CAP 까지 줄인다
game_export._face_target = lambda n: min(n, CAP)

rigs = [o for o in bpy.data.objects if o.type == "ARMATURE"]
if not rigs:
    raise SystemExit("[doll] 뼈대(아마추어)를 찾지 못했습니다")
rig = next((o for o in rigs if o.name == "DollRig"), rigs[0])
parts = [o for o in bpy.data.objects if o.type == "MESH" and o.parent == rig]
for c in bpy.data.collections:
    c.hide_viewport = c.hide_render = False
for o in [rig] + parts:
    o.hide_viewport = False
# 쉬는 자세로 내보내기 (액션은 내보내기 옵션이 따로 모은다)
ad = rig.animation_data
saved = ad.action if ad else None
if ad:
    ad.action = None
for pb in rig.pose.bones:
    pb.location = (0, 0, 0)
    pb.rotation_quaternion = (1, 0, 0, 0)
    pb.rotation_euler = (0, 0, 0)
    pb.scale = (1, 1, 1)
# 뼈대의 조상(DollSpot → DollMover)은 방 장면 속 위치·옆걸음 이동이다. 게임용은 원점 기준이므로 모두 치운다
p = rig.parent
while p is not None:
    p.animation_data_clear()
    p.location = (0, 0, 0)
    p.rotation_euler = (0, 0, 0)
    p = p.parent
bpy.context.view_layer.update()

doll_actions.build(rig)
bpy.context.view_layer.update()
off = rig.matrix_world.translation
if off.length > 1e-4:
    raise SystemExit(f"[doll] 뼈대가 원점이 아닙니다: {tuple(off)}")
n, tris = game_export.export_game([rig] + parts, OUT, None, animations=True)
if ad:
    ad.action = saved
print(f"[doll] {OUT}: 뼈대 {rig.name}, 메시 {n}개, 삼각형 약 {tris}")
