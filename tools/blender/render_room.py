"""TV 배경 렌더: 배치 파일대로 방을 만들어 TV 시점 PNG 와 방 안 환경광 HDR 을 렌더한다.

    blender -b --factory-startup -P tools/blender/render_room.py -- <방> <배치.json> <데이터 폴더> <출력 폴더> [시간대...]

  <데이터 폴더> : 배치의 image("artworks/x.png") 를 찾는 기준 (리본 서버에서는 data/)
  <출력 폴더>   : <방>_<시간대>.png (TV 배경), <방>_<시간대>_env.hdr (리본이 조명용 360° 환경)
환경변수 RENDER_SHELL_ROOM 을 주면 그 방의 모양·조명으로 짓고 파일 이름만 <방> 을 쓴다 (아이 전시실).
  [시간대]      : phases.py 의 이름 (dawn/morning/day/sunset/night). 여러 개면 방을 한 번만 짓고
                  조명만 바꿔 차례로 렌더한다. 빼면 그 방이 쓰는 시간대 전부
환경변수
  RENDER_PCT      해상도 % (기본 50 → 1920x1080, 100 → 3840x2160)
  RENDER_SAMPLES  배경 샘플 수 (기본 96)
  RENDER_ENV      0 이면 환경 HDR 건너뜀
  RENDER_HIDE     쉼표로 나눈 이름 접두어. 그 이름으로 시작하는 구조물은 빼고 렌더한다
                  (전시장 천장 레일 조명: 작품을 돋보이게 하는 일은 작품별 하이라이트가 한다)
  RENDER_PANO     "x,y,z" 를 주면 그 자리에서 본 360° 파노라마 <방>_<시간대>_pano.jpg 도 렌더한다
                  (전시실 둘러보기: 스와이프로 왼쪽·오른쪽 벽을 돌려 본다). RENDER_PANO_W 는 가로 픽셀 (기본 4096)

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
    raise SystemExit("사용법: -- <방> <배치.json> <데이터 폴더> <출력 폴더> [시간대...]")
ROOM, LAYOUT_FILE, DATA_DIR, OUT_DIR = argv[:4]
# 방 모양·조명을 가져올 방 (아이 전시실처럼 남의 껍데기를 쓰는 방이 있다). 파일 이름은 ROOM 그대로
SHELL = os.environ.get("RENDER_SHELL_ROOM") or ROOM
os.environ["MAP_ROOM"] = SHELL
import phases  # noqa: E402
import room_map  # noqa: E402  (불러올 때 기본 배치를 읽지만 아래에서 바꾼다)

PHASES = [p for p in argv[4:] if p in phases.PHASES] or room_map.room_phases(SHELL)

room_map.PROJECT_DIR = os.path.abspath(DATA_DIR)          # 그림 파일 기준
room_map.CURRENT_ROOM = SHELL
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
room_map.build_room(coll.objects.link, layout=layout, room=SHELL)
HIDE = tuple(p for p in os.environ.get("RENDER_HIDE", "").split(",") if p)
if HIDE:
    gone = [o for o in coll.objects if o.name.startswith(HIDE)]
    for o in gone:
        bpy.data.objects.remove(o, do_unlink=True)
    print(f"[render] 뺀 구조물 {len(gone)}개: {', '.join(HIDE)}")
world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
use_gpu(scene)
scene.cycles.use_denoising = True
scene.render.film_transparent = False

cam = room_map.tv_camera(scene.collection.objects.link)
env_cam = bpy.data.cameras.new("EnvCam")
env_cam.type = "PANO"
env_cam.panorama_type = "EQUIRECTANGULAR"
env_obj = bpy.data.objects.new("EnvCam", env_cam)
spot = layout.get("doll_spot") or {"x": 0.0, "y": 0.0}
env_obj.location = (float(spot["x"]), float(spot["y"]), 1.6)
env_obj.rotation_euler = (math.radians(90), 0, math.radians(-90))
scene.collection.objects.link(env_obj)

# 둘러보기용 360° (TV 배경과 같은 톤으로 굽는다. 위치는 서버가 방 가운데 눈높이로 정해 준다)
pano_obj = None
front_wall = None
if os.environ.get("RENDER_PANO"):
    pano_cam = bpy.data.cameras.new("PanoCam")
    pano_cam.type = "PANO"
    pano_cam.panorama_type = "EQUIRECTANGULAR"
    pano_obj = bpy.data.objects.new("PanoCam", pano_cam)
    pano_obj.location = tuple(float(v) for v in os.environ["RENDER_PANO"].split(","))
    pano_obj.rotation_euler = (math.radians(90), 0, math.radians(-90))     # 환경 HDR 과 같은 방향 (+X 가 그림 가운데)
    scene.collection.objects.link(pano_obj)
    # 방은 TV 쪽(앞)이 뚫려 있다. 둘러볼 때 옆벽 끝으로 바깥 하늘이 보이지 않게 파노라마에만 앞벽을 세운다.
    # 카메라에만 보이게 해서(그림자·반사 없음) 방 안 빛은 TV 배경과 똑같이 둔다
    back = bpy.data.objects.get("WallBack")
    if back is not None:
        W, H, T = room_map.ROOM_W, room_map.ROOM_H, room_map.WALL_T
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, room_map.FRONT_Y - T / 2, H / 2))
        front_wall = bpy.context.active_object
        front_wall.name = "PanoFrontWall"
        front_wall.scale = (W + 2 * T, T, H + 2 * T)
        front_wall.data.materials.append(back.data.materials[0] if back.data.materials else None)
        front_wall.visible_diffuse = front_wall.visible_glossy = False
        front_wall.visible_transmission = front_wall.visible_shadow = False
        front_wall.hide_render = True              # 파노라마를 찍을 때만 켠다
PANO_W = int(os.environ.get("RENDER_PANO_W", "4096"))

lights = []
for phase in PHASES:
    for o in lights:                       # 시간대마다 조명을 새로 놓는다
        bpy.data.objects.remove(o, do_unlink=True)
    lights = room_map.room_lights(coll.objects.link, room=SHELL, phase=phase)
    sky, exposure = room_map.apply_phase(phase, room=SHELL)
    world.node_tree.nodes["Background"].inputs["Color"].default_value = sky
    scene.view_settings.exposure = exposure

    # 1) TV 배경
    scene.camera = cam
    scene.cycles.samples = SAMPLES
    scene.render.resolution_x, scene.render.resolution_y = room_map.TV_RES
    scene.render.resolution_percentage = PCT
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    scene.render.filepath = os.path.join(OUT_DIR, f"{ROOM}_{phase}.png")
    bpy.ops.render.render(write_still=True)
    print("[render] saved", scene.render.filepath)

    # 2) 환경광: 리본이 눈높이에서 본 360° (three.js 의 +X 가 그림 가운데가 되도록 +X 를 바라봄)
    if os.environ.get("RENDER_ENV", "1") != "0":
        scene.camera = env_obj
        scene.cycles.samples = max(16, SAMPLES // 3)
        scene.render.resolution_x, scene.render.resolution_y = 1024, 512
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "HDR"
        scene.view_settings.view_transform = "Standard"   # 조명값 그대로 (톤매핑은 three.js 가)
        scene.render.filepath = os.path.join(OUT_DIR, f"{ROOM}_{phase}_env.hdr")
        bpy.ops.render.render(write_still=True)
        print("[render] saved", scene.render.filepath)

    # 3) 둘러보기 파노라마
    if pano_obj is not None:
        if front_wall is not None:
            front_wall.hide_render = False
        scene.camera = pano_obj
        scene.cycles.samples = SAMPLES
        scene.render.resolution_x, scene.render.resolution_y = PANO_W, PANO_W // 2
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "JPEG"
        scene.render.image_settings.quality = 93
        scene.view_settings.view_transform = "AgX"
        scene.render.filepath = os.path.join(OUT_DIR, f"{ROOM}_{phase}_pano.jpg")
        bpy.ops.render.render(write_still=True)
        print("[render] saved", scene.render.filepath)
        if front_wall is not None:
            front_wall.hide_render = True
