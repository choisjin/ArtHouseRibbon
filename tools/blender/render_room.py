"""TV 배경 렌더: 배치 파일대로 방을 만들어 TV 시점 PNG 와 방 안 환경광 HDR 을 렌더한다.

    blender -b --factory-startup -P tools/blender/render_room.py -- <방> <배치.json> <데이터 폴더> <출력 폴더>

  <데이터 폴더> : 배치의 image("artworks/x.png") 를 찾는 기준 (리본 서버에서는 data/)
  <출력 폴더>   : <방>.png (TV 배경), <방>_env.hdr (리본이 조명용 360° 환경)
환경변수
  RENDER_PCT      해상도 % (기본 50 → 1920x1080, 100 → 3840x2160)
  RENDER_SAMPLES  배경 샘플 수 (기본 96)
  RENDER_ENV      0 이면 환경 HDR 건너뜀

방·가구 모양은 room_map.py (Character_Creator 에서 tools/sync_world.py 로 복사) 가 만든다.
서버(world_store.py) 가 편집기 저장 뒤 자동으로 실행한다.
"""
import json
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) < 4:
    raise SystemExit("사용법: -- <방> <배치.json> <데이터 폴더> <출력 폴더>")
ROOM, LAYOUT_FILE, DATA_DIR, OUT_DIR = argv[:4]
os.environ["MAP_ROOM"] = ROOM
import room_map  # noqa: E402  (불러올 때 기본 배치를 읽지만 아래에서 바꾼다)

room_map.PROJECT_DIR = os.path.abspath(DATA_DIR)          # 그림 파일 기준
room_map.CURRENT_ROOM = ROOM
with open(LAYOUT_FILE, encoding="utf-8") as f:
    layout = json.load(f)
layout["items"] = [e for e in layout.get("items", []) if e.get("type") in room_map.ITEM_TYPES]
layout.setdefault("arts", [])

PCT = int(os.environ.get("RENDER_PCT", "50"))
SAMPLES = int(os.environ.get("RENDER_SAMPLES", "96"))
os.makedirs(OUT_DIR, exist_ok=True)


def use_gpu(scene):
    scene.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
            try:
                prefs.compute_device_type = kind
            except TypeError:
                continue
            prefs.get_devices()
            gpus = [d for d in prefs.devices if d.type == kind]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type == kind
                scene.cycles.device = "GPU"
                print(f"[render] GPU: {kind} ({', '.join(d.name for d in gpus)})")
                return
    except Exception as ex:  # noqa: BLE001
        print("[render] GPU 설정 실패:", ex)
    print("[render] CPU 로 렌더합니다")


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
coll = bpy.data.collections.new("Map")
scene.collection.children.link(coll)
room_map.build_room(coll.objects.link, layout=layout, room=ROOM)
room_map.room_lights(coll.objects.link, room=ROOM)
world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = room_map.ROOM_WORLD
use_gpu(scene)
scene.cycles.use_denoising = True
scene.view_settings.view_transform = "AgX"
scene.view_settings.exposure = room_map.ROOM_EXPOSURE
scene.render.film_transparent = False

# 1) TV 배경
cam = room_map.tv_camera(scene.collection.objects.link)
scene.camera = cam
scene.cycles.samples = SAMPLES
scene.render.resolution_x, scene.render.resolution_y = room_map.TV_RES
scene.render.resolution_percentage = PCT
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = os.path.join(OUT_DIR, f"{ROOM}.png")
bpy.ops.render.render(write_still=True)
print("[render] saved", scene.render.filepath)

# 2) 환경광: 리본이 눈높이에서 본 360° (three.js 의 +X 가 그림 가운데가 되도록 +X 를 바라봄)
if os.environ.get("RENDER_ENV", "1") != "0":
    cd = bpy.data.cameras.new("EnvCam")
    cd.type = "PANO"
    cd.panorama_type = "EQUIRECTANGULAR"
    env = bpy.data.objects.new("EnvCam", cd)
    spot = layout.get("doll_spot") or {"x": 0.0, "y": 0.0}
    env.location = (float(spot["x"]), float(spot["y"]), 1.6)
    env.rotation_euler = (math.radians(90), 0, math.radians(-90))
    scene.collection.objects.link(env)
    scene.camera = env
    scene.cycles.samples = max(16, SAMPLES // 3)
    scene.render.resolution_x, scene.render.resolution_y = 1024, 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "HDR"
    scene.view_settings.view_transform = "Standard"     # 조명값 그대로 (톤매핑은 three.js 가)
    scene.render.filepath = os.path.join(OUT_DIR, f"{ROOM}_env.hdr")
    bpy.ops.render.render(write_still=True)
    print("[render] saved", scene.render.filepath)
