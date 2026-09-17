"""리본이 인형을 고화질로 다시 내보낸다 (Character_Creator/doll.blend → client/public/world/doll.glb)

    blender -b <Character_Creator>/doll.blend --factory-startup -P tools/blender/export_doll.py -- [out.glb] [면 상한]

doll.py 의 기본 내보내기는 메시당 최대 5000면으로 줄여서 머리카락·옷이 뭉툭하다.
여기서는 상한을 크게(기본 24000면) 잡아 모양을 살린다. 액션(Walk, Greet)은 그대로.
"""
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import game_export  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = argv[0] if argv else os.path.join(ROOT, "client", "public", "world", "doll.glb")
CAP = int(argv[1]) if len(argv) > 1 else 24000

# 작은 부품은 그대로, 큰 부품만 CAP 까지 줄인다
game_export._face_target = lambda n: min(n, CAP)

rig = bpy.data.objects["DollRig"]
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
spot = rig.parent
if spot is not None:
    spot.animation_data_clear()
    spot.location = (0, 0, 0)
    spot.rotation_euler = (0, 0, 0)
bpy.context.view_layer.update()

n, tris = game_export.export_game([rig] + parts, OUT, None, animations=True)
if ad:
    ad.action = saved
print(f"[doll] {OUT}: 메시 {n}개, 삼각형 약 {tris}")
