"""TV 화면에 띄울 박스형 방(앞이 열린 디오라마) 맵 (Blender 5.2)

- 폭 15.6 × 높이 8.775(16:9) × 깊이 약 15.1 의 앞이 열린 방. 입구 네 모서리가 3840×2160 화면 모서리와 딱 맞아
  TV 속에 방이 들어 있는 것처럼 보인다 (테두리 없음)
  둘레에 봉제 느낌의 둥근 액자 테두리를 둘러 'TV 속 상자' 처럼 보이게 한다.
- 정면벽: 아무것도 없는 아이보리 민무늬 벽 / 우측벽: 바닥~천장 통유리 + 약 90cm 간격 세로 샷시
- 소품: 러그, 장난감 블록, 화분, 방석, 천장 조명
- 정면벽 오른쪽 끝: 하부장 2개 (123×61×85cm = 82cm 제품의 1.5배, 문 2짝)
  왼쪽 = 상판 가운데 기준 오른쪽에 매립 싱크볼 + 코브라 수전, 왼쪽에 정수기
  오른쪽 = 건조대에 팔레트 말리기, 붓꽂이 컵, 수건 위 붓
  싱크볼 앞 바닥에 노란 2단 어린이 발판 (40×38×33cm)
- 책상: 235×100×74cm 트레슬 책상 (원목 상판 + 검정 다리), 긴 쪽이 줄무늬 벽과 수직, 가까운 끝이 벽에서 1.5m
  의자: 긴 쪽마다 4개 = 어린이 높은 의자(빨강 2, 검정 2) 양 끝 + 검정 윈저 의자 4개 가운데
- DOLL_SPOT: 방 장면에서 인형이 서고 걷는 자리 (doll.py 가 사용)
- 왼쪽 벽 (참고 left_wall.jpg): 수납장 위로 큰 유리창 + 흰 세로 창살, 가운데 빨강/분홍 줄무늬 기둥,
  앞쪽 끝과 정면벽 쪽 모서리에 흰 벽기둥 (창밖 배경 없음, 창으로는 옅은 하늘빛 배경색만 보임)
- 수납장은 도면 치수 그대로 (1m = 2.22):
  벽을 바라보고 왼쪽(방 앞쪽) = 좌측장.pdf: 벽기둥 쪽부터 위가 열린 수납칸 722mm / 손가락홈 서류 트레이 573mm /
    선반 3칸 609mm (기둥 쪽)
  오른쪽(방 뒤쪽) = 우측장.pdf: 기둥 쪽부터 선반 2장짜리 구역 1038mm × 2 / 비스듬 칸막이 칸 374·338·307mm (모서리)
- doll.py 에서 import 해 인형과 함께 렌더할 수 있고, 단독 실행도 된다.

단독 실행:
  blender -b --factory-startup -P room_map.py -- [out_dir]
  (MAP_BUILD_ONLY=1 이면 렌더/내보내기 없이 map.blend 만 저장,
   MAP_SKIP_RENDER=1 이면 렌더 없이 내보내기만, MAP_RES_PCT=25 등으로 미리보기 해상도)
  → export/room_shell.glb, export/catalog/<가구>.glb, export/catalog.json (배치 편집기용)
- 가구 배치는 layout.json (없으면 기본 배치). 편집기: python tools/layout_server.py
  → out_dir/map_tv.png, export/map_room.glb, export/map_room.fbx, map.blend
"""
import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector, Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # 블렌더는 -P 로 연 스크립트 폴더를 경로에 넣지 않는다
import phases  # noqa: E402

# 실제 비율: 허리높이 수납장 0.9m = 2.0  ->  1m = 2.22
UNIT = 2.0 / 0.9


def mm(v):
    """도면 mm → 장면 단위"""
    return v / 1000.0 * UNIT


LCAB_LEN = mm(609 * 3 + 573 + 722)            # 좌측장 3121mm (벽을 보고 왼쪽 = 방 앞쪽)
RCAB_LEN = mm(307 + 338 + 374 + 1038 * 2)     # 우측장 3095mm (벽을 보고 오른쪽 = 방 뒤쪽)
PIL_W, PIER_W = 1.8, 0.45      # 가운데 기둥 폭(처음 0.9의 2배) / 양 끝 벽기둥 폭 (앞뒤 방향)
PIL_D = 1.3                     # 가운데 기둥·귀퉁이 기둥이 방 안쪽으로 튀어나온 깊이
ROOM_W = 12.0 * 1.3 + 2 * PIL_D  # 가로 18.2: 15.6 + 네 귀퉁이 기둥이 먹는 폭. 쓸 수 있는 바닥 폭은 그대로
ROOM_H = ROOM_W * 9 / 16        # 높이 10.24: 입구가 16:9 → 3840×2160 화면에 딱 맞음 (폭을 늘리면 같이 커진다)
TV_RES = (3840, 2160)
ROOM_WORLD = (0.62, 0.70, 0.80, 1.0)  # 왼쪽 창으로 보이는 하늘빛 (시간대에 따라 phases.py 가 바꾼다)
ROOM_EXPOSURE = -0.9            # 렌더 노출(EV) 기본값 (미술실은 시간대마다 phases.py 가 따로 정한다)
GALLERY_EXPOSURE = -0.35        # 전시장 렌더 노출
CORR_W = 6.5                    # 오른쪽 유리벽 밖 상가 복도 폭 (약 3m). 천장 높이는 방과 같다
SX = ROOM_W / 12.0             # 바닥 소품 위치를 가로 비율에 맞춰 늘리는 계수
ROOM_D = LCAB_LEN + RCAB_LEN + PIL_W + 2 * PIER_W  # 약 16.5 (앞 벽기둥 + 좌측장 + 기둥 + 우측장 + 뒤 벽기둥)
FRONT_Y = -ROOM_D / 2          # 열린 앞면
BACK_Y = ROOM_D / 2
PILLAR_Y = FRONT_Y + PIER_W + LCAB_LEN + PIL_W / 2   # 가운데 기둥 중심 (앞쪽이 좌측장)
WALL_T = 0.25
TV_LENS = 35.0


def srgb(r, g, b):
    def f(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (f(r), f(g), f(b))


# ---------- 재질 ----------
def _base(name, color, rough=0.85, sheen=0.4):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Sheen Weight"].default_value = sheen
    m.diffuse_color = (*color, 1)
    return m, m.node_tree, p


def _mix_to_base(nt, p, fac_socket, c1, c2):
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["A"].default_value = (*c1, 1)
    mix.inputs["B"].default_value = (*c2, 1)
    nt.links.new(fac_socket, mix.inputs["Factor"])
    nt.links.new(mix.outputs["Result"], p.inputs["Base Color"])


def _coords(nt, scale):
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = scale
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    return mp.outputs["Vector"]


def mat_polka(name, bg, dot, scale=1.6, size=0.22):
    """물방울 무늬 벽지"""
    m, nt, p = _base(name, bg)
    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.inputs["Scale"].default_value = scale
    vor.inputs["Randomness"].default_value = 0.0
    nt.links.new(_coords(nt, (1, 1, 1)), vor.inputs["Vector"])
    lt = nt.nodes.new("ShaderNodeMath")
    lt.operation = "LESS_THAN"
    lt.inputs[1].default_value = size
    nt.links.new(vor.outputs["Distance"], lt.inputs[0])
    _mix_to_base(nt, p, lt.outputs["Value"], bg, dot)
    return m


def mat_stripes(name, bg, stripe, scale=1.2):
    """세로 줄무늬 벽지"""
    m, nt, p = _base(name, bg)
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.bands_direction = "X"
    wave.wave_profile = "SIN"
    wave.inputs["Scale"].default_value = scale
    wave.inputs["Distortion"].default_value = 0.0
    wave.inputs["Detail"].default_value = 0.0
    nt.links.new(_coords(nt, (1, 1, 1)), wave.inputs["Vector"])
    gt = nt.nodes.new("ShaderNodeMath")
    gt.operation = "GREATER_THAN"
    gt.inputs[1].default_value = 0.62
    nt.links.new(wave.outputs["Fac"], gt.inputs[0])
    _mix_to_base(nt, p, gt.outputs["Value"], bg, stripe)
    return m


def mat_planks(name, c1, c2):
    """나무 마루"""
    m, nt, p = _base(name, c1, rough=0.6, sheen=0.1)
    brick = nt.nodes.new("ShaderNodeTexBrick")
    brick.inputs["Color1"].default_value = (*c1, 1)
    brick.inputs["Color2"].default_value = (*c2, 1)
    brick.inputs["Mortar"].default_value = (*[v * 0.6 for v in c2], 1)
    brick.inputs["Scale"].default_value = 1.0
    brick.inputs["Mortar Size"].default_value = 0.012
    brick.inputs["Brick Width"].default_value = 2.4
    brick.inputs["Row Height"].default_value = 0.6
    brick.offset = 0.5
    nt.links.new(_coords(nt, (1, 1, 1)), brick.inputs["Vector"])
    nt.links.new(brick.outputs["Color"], p.inputs["Base Color"])
    return m


def mat_strips(name, c1, c2):
    """책상 상판: 길이 방향(y)으로 긴 원목 조각을 이어 붙인 결"""
    m, nt, p = _base(name, c1, rough=0.45, sheen=0.1)
    brick = nt.nodes.new("ShaderNodeTexBrick")
    brick.inputs["Color1"].default_value = (*c1, 1)
    brick.inputs["Color2"].default_value = (*c2, 1)
    brick.inputs["Mortar"].default_value = (*[v * 0.8 for v in c2], 1)
    brick.inputs["Scale"].default_value = 1.0
    brick.inputs["Mortar Size"].default_value = 0.004
    brick.inputs["Bias"].default_value = 0.2
    brick.inputs["Brick Width"].default_value = 1.1
    brick.inputs["Row Height"].default_value = 0.09
    brick.offset = 0.37
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Rotation"].default_value = (0, 0, math.radians(90))
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    nt.links.new(mp.outputs["Vector"], brick.inputs["Vector"])
    nt.links.new(brick.outputs["Color"], p.inputs["Base Color"])
    return m


def mat_rings(name, c1, c2, scale=1.2):
    """동심원 러그"""
    m, nt, p = _base(name, c1, sheen=1.0)
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type = "RINGS"
    wave.inputs["Scale"].default_value = scale
    wave.inputs["Distortion"].default_value = 0.0
    nt.links.new(_coords(nt, (1, 2, 1)), wave.inputs["Vector"])
    gt = nt.nodes.new("ShaderNodeMath")
    gt.operation = "GREATER_THAN"
    gt.inputs[1].default_value = 0.5
    nt.links.new(wave.outputs["Fac"], gt.inputs[0])
    _mix_to_base(nt, p, gt.outputs["Value"], c1, c2)
    return m


def mat_sky(name):
    """창밖 하늘 (위는 파랗고 아래는 밝게, 스스로 빛남)"""
    m, nt, p = _base(name, srgb(170, 215, 250), rough=0.3, sheen=0.0)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Generated"], sep.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (*srgb(250, 250, 235), 1)
    ramp.color_ramp.elements[1].color = (*srgb(120, 190, 245), 1)
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], p.inputs["Base Color"])
    nt.links.new(ramp.outputs["Color"], p.inputs["Emission Color"])
    p.inputs["Emission Strength"].default_value = 1.2
    return m


def mat_glass(name):
    """통유리: 투명 + 살짝 푸른 기 (게임용은 반투명 하늘색)"""
    m, nt, p = _base(name, srgb(225, 240, 250), rough=0.02, sheen=0.0)
    p.inputs["Transmission Weight"].default_value = 1.0
    p.inputs["IOR"].default_value = 1.45
    m.diffuse_color = (*srgb(200, 228, 245), 0.25)
    return m


def mat_metal(name, color, rough=0.25):
    """스테인리스 (게임용은 회색 단색)"""
    m, nt, p = _base(name, color, rough=rough, sheen=0.0)
    p.inputs["Metallic"].default_value = 1.0
    return m


def mat_plain(name, color, rough=0.8, sheen=0.5, emit=0.0):
    m, nt, p = _base(name, color, rough, sheen)
    if emit:
        p.inputs["Emission Color"].default_value = (*color, 1)
        p.inputs["Emission Strength"].default_value = emit
    return m


# ---------- 도형 ----------
class Builder:
    def __init__(self, link):
        self.link = link
        self.objs = []

    def obj(self, name, bm, mat, bevel=0.0, subsurf=0, smooth=True):
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        if smooth:
            for p in me.polygons:
                p.use_smooth = True
        me.materials.append(mat)
        o = bpy.data.objects.new(name, me)
        self.link(o)
        if bevel:
            b = o.modifiers.new("Bevel", "BEVEL")
            b.width = bevel
            b.segments = 4
            b.limit_method = "NONE"
            o.modifiers.new("WN", "WEIGHTED_NORMAL")
        if subsurf:
            s = o.modifiers.new("Subsurf", "SUBSURF")
            s.levels = s.render_levels = subsurf
        self.objs.append(o)
        return o

    def box(self, name, center, size, mat, bevel=0.06):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Diagonal((*size, 1)))
        o = self.obj(name, bm, mat, bevel=bevel, smooth=False)
        o.location = center
        return o

    def cyl(self, name, center, r, h, mat, bevel=0.04, segs=48, r2=None):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r, radius2=r if r2 is None else r2,
                              depth=h)
        o = self.obj(name, bm, mat, bevel=bevel, smooth=False)
        o.location = center
        return o

    def ball(self, name, center, semi, mat, rot=(0, 0, 0)):
        bm = bmesh.new()
        from mathutils import Euler
        m = Euler(rot).to_matrix().to_4x4() @ Matrix.Diagonal((*semi, 1))
        bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=1.0, matrix=m)
        o = self.obj(name, bm, mat)
        o.location = center
        return o

    def prism(self, name, pts2d, y0, depth, z0, mat, bevel=0.03, plane="XZ"):
        """정면(XZ) 다각형을 Y방향으로 두께를 준 판"""
        bm = bmesh.new()
        front = [bm.verts.new((x, y0, z0 + z)) for x, z in pts2d]
        back = [bm.verts.new((x, y0 + depth, z0 + z)) for x, z in pts2d]
        bm.faces.new(front)
        bm.faces.new(list(reversed(back)))
        n = len(pts2d)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((front[i], front[j], back[j], back[i]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        return self.obj(name, bm, mat, bevel=bevel, smooth=False)


def make_materials():
    return {
        "ivory": mat_plain("WallIvory", srgb(250, 244, 228), rough=0.9, sheen=0.2),
        "ceil": mat_plain("Ceiling", srgb(255, 248, 236)),
        "floor": mat_planks("Floor", srgb(230, 220, 204), srgb(218, 206, 188)),   # 전시실 바닥과 같은 색
        "trim": mat_plain("Trim", srgb(255, 252, 245), rough=0.5, sheen=0.2),
        "frame": mat_plain("TVFrame", srgb(255, 190, 200), rough=0.7, sheen=1.0),
        "rug": mat_rings("Rug", srgb(255, 236, 170), srgb(255, 214, 120), scale=1.3),
        "sky": mat_sky("Sky"),
        "curtain": mat_plain("Curtain", srgb(250, 150, 170), sheen=1.0),
        "wood": mat_plain("ShelfWood", srgb(214, 160, 110), rough=0.6, sheen=0.1),
        "star": mat_plain("Star", srgb(255, 214, 90), rough=0.5, sheen=0.6),
        "red": mat_plain("ToyRed", srgb(240, 100, 110)),
        "blue": mat_plain("ToyBlue", srgb(120, 180, 240)),
        "yellow": mat_plain("ToyYellow", srgb(255, 210, 90)),
        "green": mat_plain("Leaf", srgb(110, 190, 120)),
        "pot": mat_plain("Pot", srgb(230, 150, 110), rough=0.6),
        "panel": mat_plain("PanelLight", srgb(255, 250, 242), rough=0.35, sheen=0.0, emit=2.0),
        # 오른쪽 유리벽 밖 상가 복도
        "corr_floor": mat_plain("CorridorFloor", srgb(214, 210, 204), rough=0.25, sheen=0.2),
        "corr_wall": mat_plain("CorridorWall", srgb(228, 226, 222), rough=0.8, sheen=0.1),
        "corr_ceil": mat_plain("CorridorCeiling", srgb(238, 236, 232), rough=0.9, sheen=0.0),
        "corr_light": mat_plain("CorridorLightPanel", srgb(255, 250, 240), rough=0.3, sheen=0.0, emit=2.2),
        # 복도 맞은편 통유리벽: 검은 시트지 (빛을 거의 안 통과시키고 살짝 비친다)
        "film_glass": mat_plain("BlackFilmGlass", srgb(26, 26, 30), rough=0.12, sheen=0.0),
        "purple": mat_plain("ToyPurple", srgb(190, 160, 235)),
        "pillar_r": mat_plain("PillarRed", srgb(222, 78, 80), rough=0.7, sheen=0.3),
        "pillar_p": mat_plain("PillarPink", srgb(242, 150, 176), rough=0.7, sheen=0.3),
        "tree_g": mat_plain("TreeGreen", srgb(74, 160, 106), rough=0.7, sheen=0.3),
        "glass": mat_glass("WindowGlass"),
        "cab": mat_plain("CabinetWood", srgb(214, 140, 64), rough=0.45, sheen=0.1),
        "cab_door": mat_plain("CabinetDoor", srgb(226, 176, 122), rough=0.5, sheen=0.1),
        "cab_dark": mat_plain("CabinetPlinth", srgb(150, 100, 62), rough=0.6, sheen=0.1),
        "cab_in": mat_plain("CabinetInside", srgb(176, 118, 66), rough=0.6, sheen=0.1),
        "lwall": mat_plain("WallLeftPlain", srgb(250, 244, 236), rough=0.9, sheen=0.2),
        "knob": mat_plain("Knob", srgb(236, 196, 96), rough=0.25, sheen=0.0),
        "base_body": mat_plain("BaseCabBody", srgb(248, 246, 240), rough=0.5, sheen=0.1),
        "base_door": mat_plain("BaseCabDoor", srgb(252, 250, 246), rough=0.35, sheen=0.1),
        "counter": mat_plain("Countertop", srgb(222, 184, 138), rough=0.4, sheen=0.1),
        "steel": mat_metal("Steel", srgb(210, 214, 218)),
        "steel_dark": mat_metal("SteelDark", srgb(120, 124, 130), rough=0.4),
        "purifier": mat_plain("Purifier", srgb(250, 250, 252), rough=0.3, sheen=0.0),
        "purifier_dark": mat_plain("PurifierDark", srgb(70, 78, 90), rough=0.4, sheen=0.0),
        "purifier_btn": mat_plain("PurifierBtn", srgb(200, 206, 214), rough=0.3, sheen=0.0),
        "blue_light": mat_plain("BlueLight", srgb(90, 180, 255), rough=0.3, sheen=0.0, emit=3.0),
        "rack": mat_plain("DryRack", srgb(170, 225, 215), rough=0.5, sheen=0.0),
        "palette": mat_plain("Palette", srgb(250, 250, 250), rough=0.3, sheen=0.0),
        "cup": mat_plain("BrushCup", srgb(150, 200, 240), rough=0.4, sheen=0.0),
        "brush_hair": mat_plain("BrushHair", srgb(60, 44, 34), rough=0.8, sheen=0.5),
        "towel": mat_plain("Towel", srgb(255, 236, 200), rough=0.95, sheen=1.0),
        "stool": mat_plain("StepStool", srgb(250, 200, 40), rough=0.35, sheen=0.1),
        "bezel": mat_plain("TVBezel", srgb(18, 18, 26), rough=0.6, sheen=0.0),
        "acacia": mat_strips("TableAcacia", srgb(214, 160, 100), srgb(176, 118, 64)),
        "table_black": mat_plain("TableBlack", srgb(34, 34, 36), rough=0.5, sheen=0.1),
        "chair_red": mat_plain("ChairRed", srgb(206, 38, 42), rough=0.4, sheen=0.1),
        "chair_black": mat_plain("ChairBlack", srgb(36, 36, 38), rough=0.45, sheen=0.1),
        "grass": mat_plain("Grass", srgb(150, 205, 120), rough=0.9),
        "trunk": mat_plain("Trunk", srgb(150, 105, 70)),
        "tree": mat_plain("TreeLeaf", srgb(120, 190, 110)),
        # 전시장
        "gwall": mat_plain("GalleryWall", srgb(248, 247, 243), rough=0.9, sheen=0.1),
        "gceil": mat_plain("GalleryCeiling", srgb(252, 252, 250)),
        "gfloor": mat_planks("GalleryFloor", srgb(230, 220, 204), srgb(218, 206, 188)),
        "gskirt": mat_plain("GallerySkirt", srgb(226, 224, 219), rough=0.6, sheen=0.0),
        "track": mat_plain("TrackBlack", srgb(30, 30, 32), rough=0.4, sheen=0.0),
        "skylight": mat_plain("Skylight", srgb(255, 253, 248), emit=0.85),
        "bench": mat_plain("BenchFabric", srgb(120, 124, 130), rough=0.95, sheen=0.6),
        "plinth": mat_plain("PlinthWhite", srgb(250, 250, 248), rough=0.5, sheen=0.0),
        "art_canvas": mat_plain("ArtCanvasEdge", srgb(244, 241, 234), rough=0.8, sheen=0.2),
        "art_back": mat_plain("ArtBacking", srgb(60, 58, 56), rough=0.8, sheen=0.0),
        "frame_black": mat_plain("FrameBlack", srgb(29, 29, 31), rough=0.4, sheen=0.0),
        "frame_wood": mat_plain("FrameWood", srgb(168, 116, 74), rough=0.5, sheen=0.1),
        "frame_white": mat_plain("FrameWhite", srgb(246, 245, 241), rough=0.4, sheen=0.0),
    }


ROOM_ARCH = []          # 마지막 build_room 의 고정 구조물 (벽/바닥/창/기둥/조명)


def build_room(link, layout=None, room=None):
    """방 뼈대 + 배치 파일대로 가구/그림을 만들고 오브젝트 목록(가구 묶음 포함)을 반환"""
    room = room or CURRENT_ROOM
    if layout is None:
        layout = LAYOUT if room == CURRENT_ROOM else load_layout(room)
    B = Builder(link)
    M = make_materials()
    build_shell(B, M, room)
    ROOM_ARCH[:] = list(B.objs)

    # 가구 (배치 가능 항목). 그림이 걸린 이젤은 원래 그려진 캔버스를 숨김
    types_by_id = {e.get("id"): e.get("type") for e in layout.get("items", [])}
    hides = {}
    for art in layout.get("arts", []):
        host = (art.get("mount") or {}).get("host")
        if host and host in types_by_id:
            spec = find_mount(types_by_id[host], art["mount"].get("id"))
            if spec:
                hides.setdefault(host, []).extend(spec.get("hides", []))
    for entry in layout.get("items", []):
        if entry.get("type") in ITEM_TYPES:
            make_item(B, M, link, entry, hide=hides.get(entry.get("id"), ()))
    for art in layout.get("arts", []):
        make_art(B, M, art)
    return B.objs


def build_shell(B, M, room):
    if room == "gallery":
        build_gallery_shell(B, M)
    else:
        build_classroom_shell(B, M)


def build_classroom_shell(B, M):
    W, H, D, T = ROOM_W, ROOM_H, ROOM_D, WALL_T

    # 방 상자
    B.box("Floor", (0, 0, -T / 2), (W + 2 * T, D, T), M["floor"], bevel=0.0)
    B.box("Ceiling", (0, 0, H + T / 2), (W + 2 * T, D, T), M["ceil"], bevel=0.0)
    # 정면벽: 아무것도 없는 아이보리 민무늬 (걸레받이만)
    B.box("WallBack", (0, BACK_Y + T / 2, H / 2), (W + 2 * T, T, H + 2 * T), M["ivory"], bevel=0.04)
    B.box("BaseBack", (0, BACK_Y - 0.06, 0.12), (W, 0.12, 0.24), M["trim"], bevel=0.03)
    build_left_wall(B, M)
    build_right_glass_wall(B, M)
    build_corridor(B, M)

    # 천장 매립 조명: 천장에 묻힌 LED 평판 (1200x300) 네 귀퉁이만
    pw, pd, pt = mm(1200), mm(300), mm(25)
    for i, gx in enumerate((-W * 0.26, W * 0.26)):
        for j, gy in enumerate((-D * 0.34, D * 0.34)):
            B.box(f"CeilingPanel_{i}{j}", (gx, gy + 0.3, H - pt / 2), (pw, pd, pt), M["panel"], bevel=0.0)


def build_gallery_shell(B, M):
    """전시장: 미술실과 같은 크기의 흰 벽 방 (창 없음), 연한 원목 바닥, 천장 채광 패널 + 레일 조명"""
    W, H, D, T = ROOM_W, ROOM_H, ROOM_D, WALL_T
    B.box("Floor", (0, 0, -T / 2), (W + 2 * T, D, T), M["gfloor"], bevel=0.0)
    B.box("Ceiling", (0, 0, H + T / 2), (W + 2 * T, D, T), M["gceil"], bevel=0.0)
    B.box("WallBack", (0, BACK_Y + T / 2, H / 2), (W + 2 * T, T, H + 2 * T), M["gwall"], bevel=0.0)
    B.box("WallLeft", (-W / 2 - T / 2, 0, H / 2), (T, D, H), M["gwall"], bevel=0.0)
    B.box("WallRight", (W / 2 + T / 2, 0, H / 2), (T, D, H), M["gwall"], bevel=0.0)
    sk_h, sk_t = mm(70), mm(12)
    B.box("SkirtBack", (0, BACK_Y - sk_t / 2, sk_h / 2), (W, sk_t, sk_h), M["gskirt"], bevel=0.0)
    B.box("SkirtLeft", (-W / 2 + sk_t / 2, 0, sk_h / 2), (sk_t, D, sk_h), M["gskirt"], bevel=0.0)
    B.box("SkirtRight", (W / 2 - sk_t / 2, 0, sk_h / 2), (sk_t, D, sk_h), M["gskirt"], bevel=0.0)
    B.box("CeilingSkylight", (0, 0.3, H - mm(10)), (W * 0.35, D * 0.55, mm(20)), M["skylight"], bevel=0.0)
    rail_z = H - mm(30)
    rails = (("L", (-W / 2 + 2.0, 0.0), (mm(40), D * 0.86), (-1, 0)),
             ("R", (W / 2 - 2.0, 0.0), (mm(40), D * 0.86), (1, 0)),
             ("B", (0.0, BACK_Y - 2.0), (W * 0.8, mm(40)), (0, 1)))
    for tag, (cx, cy), (sx, sy), (dx, dy) in rails:
        B.box(f"CeilingTrack_{tag}", (cx, cy, rail_z), (sx, sy, mm(40)), M["track"], bevel=0.0)
        n = 5 if tag == "B" else 6
        for k in range(n):
            t = (k + 0.5) / n - 0.5
            px = cx + (W * 0.8 * t if tag == "B" else 0.0)
            py = cy + (0.0 if tag == "B" else D * 0.86 * t)
            top = Vector((px, py, rail_z - mm(20)))
            neck = top - Vector((0, 0, mm(120)))
            head = neck + Vector((dx, dy, -1.0)).normalized() * mm(200)
            tube(B, f"CeilingSpotStem_{tag}{k}", [top, neck], mm(10), M["track"], segs=8)
            tube(B, f"CeilingSpot_{tag}{k}", [neck, head], mm(45), M["track"], segs=16)


# 왼쪽 벽 치수 (참고: left_wall.jpg, 좌측장.pdf, 우측장.pdf)
PIER_D = 0.55                # 앞쪽 끝 흰 벽기둥 깊이 (TV 시점에서 가리지 않게 얕게)
TRANSOM = 0.22               # 왼쪽 창 가로 프레임 위치 (윗단에서 창 높이 비율)
STRIPES = 11                 # 기둥 정면 줄무늬 수 (홀수라 빨강으로 시작해 빨강으로 끝난다)
CAB_H = mm(812)              # 수납장 높이 (도면)
CAB_D = mm(397)              # 수납장 깊이 (도면)
BOARD = mm(18)               # 판 두께
SILL_Z = CAB_H + 0.12        # 창 아랫단
HEAD_Z = ROOM_H - 0.4        # 창 윗단


# ---------- 수납장 부품 ----------
class Cab:
    """벽(x=xw)에 붙은 수납장. 길이 방향 = +y, 앞면 = +x"""

    def __init__(self, B, M, name, xw, y0, mirror_c=None):
        """mirror_c가 있으면 길이 방향을 y → mirror_c - y 로 뒤집어 배치 (좌우 반전)"""
        self.B, self.M, self.name, self.xw, self.y0 = B, M, name, xw, y0
        self.xf = xw + CAB_D
        self.n = 0
        self.c = mirror_c

    def m(self, y):
        return y if self.c is None else self.c - y

    def span(self, y0, y1):
        a, b = self.m(y0), self.m(y1)
        return (a, b) if a <= b else (b, a)

    def _id(self, part):
        self.n += 1
        return f"{self.name}_{part}{self.n}"

    def board_x(self, y0, y1, z, mat="cab"):
        """바닥/선반/윗판: 길이 y0~y1, 높이 z(중심)"""
        y0, y1 = self.span(y0, y1)
        self.B.box(self._id("Board"), (self.xw + CAB_D / 2, (y0 + y1) / 2, z),
                   (CAB_D, y1 - y0, BOARD), self.M[mat], 0.004)

    def panel_y(self, y, z0=BOARD, z1=CAB_H - BOARD, mat="cab", front_gap=0.0):
        """칸막이/옆판: 위치 y (길이 방향에 수직). 기본은 바닥판과 윗판 사이에 끼움
        (같은 면이 겹치면 렌더에 검은 줄이 생김)"""
        d = CAB_D - BOARD - front_gap
        y = self.m(y)
        self.B.box(self._id("Panel"), (self.xw + BOARD + d / 2, y, (z0 + z1) / 2),
                   (d, BOARD, z1 - z0), self.M[mat], 0.003)

    def back(self, y0, y1, z1=CAB_H - BOARD):
        y0, y1 = self.span(y0, y1)
        self.B.box(self._id("Back"), (self.xw + BOARD / 2, (y0 + y1) / 2, (BOARD + z1) / 2),
                   (BOARD, y1 - y0 - 0.002, z1 - BOARD), self.M["cab_in"], 0.0)

    def front_panel(self, y0, y1, z0=BOARD, z1=CAB_H):
        y0, y1 = self.span(y0, y1)
        self.B.box(self._id("Front"), (self.xf - BOARD / 2, (y0 + y1) / 2, (z0 + z1) / 2),
                   (BOARD, y1 - y0 - 0.004, z1 - z0), self.M["cab_door"], 0.004)

    def notched_shelf(self, y0, y1, z, notch_r=mm(32)):
        """앞 가운데에 반원 손가락 홈이 파인 얇은 선반 (위에서 본 윤곽을 두께만큼 올림)"""
        y0, y1 = self.span(y0, y1)
        xw, xf, ym = self.xw + BOARD, self.xf, (y0 + y1) / 2
        pts = [(xw, y0), (xf, y0), (xf, ym - notch_r)]
        for k in range(1, 12):
            a = math.pi * k / 12
            pts.append((xf - notch_r * math.sin(a), ym - notch_r * math.cos(a)))
        pts += [(xf, ym + notch_r), (xf, y1), (xw, y1)]
        bm = bmesh.new()
        t = mm(8)
        bot = [bm.verts.new((x, y, z - t / 2)) for x, y in pts]
        top = [bm.verts.new((x, y, z + t / 2)) for x, y in pts]
        bm.faces.new(list(reversed(bot)))
        bm.faces.new(top)
        for i in range(len(pts)):
            j = (i + 1) % len(pts)
            bm.faces.new((bot[i], bot[j], top[j], top[i]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        self.B.obj(self._id("Tray"), bm, self.M["cab"], smooth=False)

    def slant_divider(self, y, lo=0.37, full_at=0.67):
        """잡지꽂이형 칸막이: 앞은 낮고(lo) 뒤로 갈수록 높아져 깊이 full_at 지점부터 최대 높이"""
        xw, d, h = self.xw + BOARD, CAB_D - BOARD, CAB_H - BOARD
        y = self.m(y)
        pts = [(xw + d, BOARD), (xw + d, BOARD + h * lo), (xw + d * (1 - full_at), BOARD + h),
               (xw, BOARD + h), (xw, BOARD)]
        self.B.prism(self._id("Slant"), pts, y - BOARD / 2, BOARD, 0.0, self.M["cab"], bevel=0.004)


def build_left_cabinet(B, M, xw, y_pillar_back, mirror_c=None):
    """좌측장 (기둥 → 바깥 끝): 선반 3칸 / 손가락홈 서류 트레이 / 위가 열린 수납칸"""
    c = Cab(B, M, "LCab", xw, y_pillar_back, mirror_c)
    y = y_pillar_back
    bays = [mm(609)] * 3
    slot_len, bin_len = mm(573), mm(722)
    total = sum(bays) + slot_len + bin_len
    c.panel_y(y + BOARD / 2)                       # 기둥 쪽 옆판
    c.board_x(y, y + total, BOARD / 2)             # 바닥판
    c.back(y, y + sum(bays) + slot_len)            # 뒤판 (윗판 아래)
    c.back(y + sum(bays) + slot_len, y + total, z1=CAB_H)   # 열린 칸 뒤판 (끝까지)
    # 선반 3칸 (선반 높이 60%)
    for k, L in enumerate(bays):
        c.board_x(y, y + L, CAB_H * 0.6)
        y += L
        c.panel_y(y)
    # 서류 트레이: 손가락 홈 선반 9장 (10단)
    for k in range(1, 10):
        c.notched_shelf(y + BOARD / 2, y + slot_len - BOARD / 2, BOARD + (CAB_H - 2 * BOARD) * k / 10)
    c.board_x(y_pillar_back, y + slot_len - BOARD / 2, CAB_H - BOARD / 2)   # 닫힌 윗판 (선반칸 + 트레이칸)
    y += slot_len
    c.panel_y(y, z1=CAB_H)                         # 트레이칸 / 열린 칸 경계 (윗판 옆으로 끝까지)
    # 위가 열린 수납칸: 앞면 막힘, 안쪽 칸막이 2장 (끝에서 415mm, 586mm)
    end = y + bin_len
    c.front_panel(y, end)
    for off in (mm(415), mm(586)):
        c.panel_y(end - off, z1=CAB_H * 0.85, front_gap=BOARD + 0.004)
    c.panel_y(end - BOARD / 2, z1=CAB_H)           # 뒤 모서리 옆판
    return end


def build_right_cabinet(B, M, xw, y_front, mirror_c=None):
    """우측장 (바깥 끝 → 기둥): 비스듬 칸막이 수납칸 / 선반 2구역(선반 2장씩)"""
    c = Cab(B, M, "RCab", xw, y_front, mirror_c)
    bins = [mm(307), mm(338), mm(374)]
    shelf_secs = [mm(1038)] * 2
    total = sum(bins) + sum(shelf_secs)
    y = y_front
    c.panel_y(y + BOARD / 2, z1=CAB_H)             # 벽기둥 쪽 옆판 (열린 칸 쪽이라 끝까지)
    c.board_x(y, y + total, BOARD / 2)
    c.back(y, y + sum(bins), z1=CAB_H)             # 열린 칸 뒤판
    c.back(y + sum(bins), y + total)               # 선반 구역 뒤판 (윗판 아래)
    # 비스듬 칸막이 칸 (위가 열림)
    for k, L in enumerate(bins):
        y += L
        if k < len(bins) - 1:
            c.slant_divider(y)
    c.panel_y(y, z1=CAB_H)                         # 선반 구역과의 칸막이 (윗판 옆으로 끝까지)
    shelves_start = y + BOARD / 2
    # 선반 2구역: 27%, 55% 높이 선반
    for k, L in enumerate(shelf_secs):
        for frac in (0.27, 0.55):
            c.board_x(y + BOARD / 2, y + L - BOARD / 2, CAB_H * frac)
        y += L
        c.panel_y(y - BOARD / 2 if k == len(shelf_secs) - 1 else y)
    c.board_x(shelves_start, y, CAB_H - BOARD / 2)   # 닫힌 윗판
    return y


def build_left_wall(B, M):
    W, H, T = ROOM_W, ROOM_H, WALL_T
    xw = -W / 2                          # 벽 안쪽 면
    pf, pb = PILLAR_Y - PIL_W / 2, PILLAR_Y + PIL_W / 2     # 기둥 앞/뒤 면
    y_front = FRONT_Y + PIER_W                               # 앞쪽 벽기둥 뒤

    # 벽: 창 아래(수납장 뒤) + 창 위
    B.box("LWall_Low", (xw - T / 2, 0, SILL_Z / 2), (T, ROOM_D, SILL_Z), M["lwall"], 0.0)
    B.box("LWall_Head", (xw - T / 2, 0, (HEAD_Z + H) / 2), (T, ROOM_D, H - HEAD_Z), M["lwall"], 0.0)

    # 앞뒤 모서리 기둥: 줄무늬 기둥과 같은 분홍, 같은 깊이로 튀어나온다
    B.box("LPier", (xw + PIL_D / 2 - T / 2, FRONT_Y + PIER_W / 2, H / 2), (PIL_D + T, PIER_W, H), M["pillar_p"], 0.03)
    B.box("LPierBack", (xw + PIL_D / 2 - T / 2, BACK_Y - PIER_W / 2 + T / 2, H / 2),
          (PIL_D + T, PIER_W + T, H), M["pillar_p"], 0.03)

    # 가운데 기둥: 빨강/분홍 세로 줄무늬 (정면 + 옆면). 양 끝은 빨강
    sw = PIL_W / STRIPES
    xf = xw + PIL_D
    for i in range(STRIPES):
        y = pf + sw * (i + 0.5)
        B.box(f"Pillar_{i}", ((xw - T + xf) / 2, y, H / 2), (xf - xw + T, sw, H),
              M["pillar_r" if i % 2 == 0 else "pillar_p"], bevel=0.0)
    n_side = max(2, round(PIL_D / sw))
    sd = PIL_D / n_side
    for s, yy in ((-1, pf - 0.006), (1, pb + 0.006)):
        for i in range(n_side):
            x = xw + sd * (i + 0.5)
            first = "pillar_r" if s < 0 else ("pillar_r" if STRIPES % 2 else "pillar_p")
            other = "pillar_p" if first == "pillar_r" else "pillar_r"
            B.box(f"PillarSide_{'F' if s < 0 else 'B'}_{i}", (x, yy, H / 2),
                  (sd, 0.012, H), M[other if i % 2 == 0 else first], bevel=0.0)

    # 창: 기둥 앞 구역 / 뒤 구역. 테두리 + 가운데 세로 프레임 1개 + 위쪽 가로 프레임 1개
    win_h = HEAD_Z - SILL_Z
    zc = (SILL_Z + HEAD_Z) / 2
    for tag, (y0, y1) in (("F", (y_front, pf)), ("B", (pb, BACK_Y - PIER_W))):
        yc, ly = (y0 + y1) / 2, y1 - y0
        B.box(f"Glass_{tag}", (xw - T / 2, yc, zc), (0.03, ly, win_h), M["glass"], bevel=0.0)
        B.box(f"Sill_{tag}", (xw + 0.05, yc, SILL_Z - 0.03), (0.3, ly, 0.06), M["trim"], 0.015)
        B.box(f"WinHead_{tag}", (xw - 0.02, yc, HEAD_Z + 0.04), (0.2, ly, 0.08), M["trim"], 0.015)
        # 양 끝 세로 테두리 + 가운데 세로 프레임
        for k, (y, wdt) in enumerate(((y0 + 0.07, 0.14), (yc, 0.16), (y1 - 0.07, 0.14))):
            B.box(f"Mullion_{tag}{k}", (xw - 0.03, y, zc), (0.2, wdt, win_h), M["trim"], 0.02)
        # 위쪽 가로 프레임 (창 윗단에서 창 높이의 22% 아래)
        B.box(f"Transom_{tag}", (xw - 0.03, yc, HEAD_Z - win_h * TRANSOM), (0.18, ly, 0.12), M["trim"], 0.02)



# ---------- 정면벽 오른쪽 끝: 하부장 2개 (싱크대 + 건조대) ----------
BASE_W, BASE_D, BASE_H = mm(820 * 1.5), mm(610), mm(850)   # 상판 폭(1.5배) / 깊이 / 전체 높이
TOP_T = mm(29)                                       # 상판 두께
BODY_W = mm(800 * 1.5)                               # 본체 폭 (1.5배)
PLINTH_H, PLINTH_IN = mm(80), mm(50)                 # 걸레받이 높이 / 들어간 깊이


def tube(B, name, pts, r, mat, segs=16):
    """점 목록을 따라가는 관 (코브라 수전 목, 붓 손잡이 등)"""
    bm = bmesh.new()
    rings = []
    # 단면 방향을 곡선을 따라 비틀림 없이 옮김 (parallel transport)
    t_prev = (pts[1] - pts[0]).normalized()
    n = t_prev.orthogonal().normalized()
    for i, p in enumerate(pts):
        a = pts[max(0, i - 1)]
        b = pts[min(len(pts) - 1, i + 1)]
        t = (b - a).normalized()
        if i:
            n = t_prev.rotation_difference(t) @ n
            n = (n - t * n.dot(t)).normalized()
        bi = t.cross(n)
        t_prev = t
        rings.append([bm.verts.new(p + (n * math.cos(2 * math.pi * k / segs) +
                                        bi * math.sin(2 * math.pi * k / segs)) * r)
                      for k in range(segs)])
    for ra, rb in zip(rings[:-1], rings[1:]):
        for k in range(segs):
            j = (k + 1) % segs
            bm.faces.new((ra[k], ra[j], rb[j], rb[k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return B.obj(name, bm, mat)


def base_cabinet(B, M, name, x0, top_hole=None):
    """하부장 한 개. x0 = 상판 왼쪽 끝. top_hole = (x0, x1, y0, y1) 이면 상판에 싱크 구멍"""
    y_back = BACK_Y
    y_front = BACK_Y - BASE_D
    cx = x0 + BASE_W / 2
    body_h = BASE_H - TOP_T
    body_d = BASE_D - mm(20)
    # 본체 (옆판 + 뒤판 + 바닥)
    for k, sx in enumerate((-1, 1)):
        B.box(f"{name}_Side{k}", (cx + sx * (BODY_W / 2 - mm(9)), y_back - body_d / 2, body_h / 2),
              (mm(18), body_d, body_h), M["base_body"], 0.004)
    B.box(f"{name}_Back", (cx, y_back - mm(9), body_h / 2), (BODY_W - mm(36), mm(18), body_h), M["base_body"], 0.0)
    # 들어간 걸레받이
    B.box(f"{name}_Plinth", (cx, y_front + mm(20) + PLINTH_IN, PLINTH_H / 2),
          (BODY_W - mm(36), mm(16), PLINTH_H), M["cab_dark"], 0.003)
    B.box(f"{name}_Bottom", (cx, y_back - body_d / 2 - PLINTH_IN / 2, PLINTH_H + mm(9)),
          (BODY_W - mm(36), body_d - PLINTH_IN, mm(18)), M["base_body"], 0.0)
    # 문 두 짝 (가운데 3mm 틈)
    door_w = (BODY_W - mm(3)) / 2
    door_h = body_h - PLINTH_H - mm(4)
    dz = PLINTH_H + door_h / 2 + mm(2)
    for k, sx in enumerate((-1, 1)):
        B.box(f"{name}_Door{k}", (cx + sx * (door_w / 2 + mm(1.5)), y_front + mm(10), dz),
              (door_w, mm(18), door_h), M["base_door"], 0.006)
        # 손잡이 대신 문 위쪽 안쪽 모서리에 작은 홈 느낌의 막대
        B.box(f"{name}_Pull{k}", (cx + sx * mm(40), y_front - mm(1), dz + door_h / 2 - mm(60)),
              (mm(40), mm(6), mm(10)), M["knob"], 0.002)
    # 상판 (구멍이 있으면 네 조각으로)
    top_z = BASE_H - TOP_T / 2
    tx0, tx1, ty0, ty1 = x0, x0 + BASE_W, y_front, y_back
    if top_hole is None:
        B.box(f"{name}_Top", (cx, (ty0 + ty1) / 2, top_z), (BASE_W, BASE_D, TOP_T), M["counter"], 0.008)
    else:
        hx0, hx1, hy0, hy1 = top_hole
        parts = [((tx0, hx0), (ty0, ty1)), ((hx1, tx1), (ty0, ty1)),
                 ((hx0, hx1), (ty0, hy0)), ((hx0, hx1), (hy1, ty1))]
        for k, ((a, b), (c, d)) in enumerate(parts):
            B.box(f"{name}_Top{k}", ((a + b) / 2, (c + d) / 2, top_z), (b - a, d - c, TOP_T), M["counter"], 0.004)
    return cx, y_front, y_back


def sink_bowl(B, M, x0, x1, y0, y1, depth):
    """상판에 매립된 사각 싱크볼: 테두리 + 안쪽이 둥근 오목한 통 + 배수구"""
    top = BASE_H
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    w, d = x1 - x0, y1 - y0
    # 통: 위가 열린 상자를 둥글게
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Diagonal((w, d, depth, 1)))
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.z > 0.5], context="FACES_ONLY")
    bowl = B.obj("SinkBowl", bm, M["steel"], smooth=False)
    bowl.location = (cx, cy, top - depth / 2 - mm(2))
    bev = bowl.modifiers.new("Bevel", "BEVEL")
    bev.width, bev.segments, bev.limit_method = mm(35), 5, "NONE"
    sol = bowl.modifiers.new("Solidify", "SOLIDIFY")
    sol.thickness = mm(4)
    bowl.modifiers.new("WN", "WEIGHTED_NORMAL")
    # 상판 위 얇은 테두리
    rim = mm(12)
    for k, (c, sz) in enumerate(((((cx, y0 - rim / 2)), (w + 2 * rim, rim)), (((cx, y1 + rim / 2)), (w + 2 * rim, rim)),
                                 (((x0 - rim / 2, cy)), (rim, d)), (((x1 + rim / 2, cy)), (rim, d)))):
        B.box(f"SinkRim{k}", (c[0], c[1], top + mm(1.5)), (sz[0], sz[1], mm(3)), M["steel"], 0.001)
    B.cyl("SinkDrain", (cx, cy, top - depth + mm(1)), mm(38), mm(4), M["steel_dark"], bevel=0.0, segs=24)


def cobra_faucet(B, M, x, y, top):
    """코브라(거위목) 수전: 받침 → 위로 솟았다가 앞으로 휘어 아래를 향하는 목 + 옆 레버"""
    B.cyl("FaucetBase", (x, y, top + mm(12)), mm(28), mm(24), M["steel"], bevel=0.002, segs=24)
    pts = []
    H, R = mm(330), mm(120)              # 세운 높이 / 휘는 반경
    for i in range(10):
        pts.append(Vector((x, y, top + mm(20) + H * i / 9)))
    for i in range(1, 17):
        a = math.pi * i / 16             # 반원을 그리며 앞(-y)으로
        pts.append(Vector((x, y - R + R * math.cos(a), top + mm(20) + H + R * math.sin(a))))
    for i in range(1, 5):
        pts.append(Vector((x, y - 2 * R, top + mm(20) + H - mm(25) * i)))
    tube(B, "FaucetNeck", pts, mm(14), M["steel"], segs=20)
    B.cyl("FaucetSpout", (x, y - 2 * R, top + mm(20) + H - mm(110)), mm(17), mm(22), M["steel_dark"],
          bevel=0.001, segs=20)
    # 레버
    B.cyl("FaucetBody", (x, y, top + mm(90)), mm(22), mm(80), M["steel"], bevel=0.002, segs=24)
    tube(B, "FaucetLever", [Vector((x + mm(20), y, top + mm(110))), Vector((x + mm(80), y + mm(10), top + mm(140))),
                            Vector((x + mm(120), y + mm(20), top + mm(150)))], mm(7), M["steel"], segs=12)


def water_purifier(B, M, cx, cy, top):
    """카운터형 정수기: 흰 몸체 + 앞쪽 오목한 출수부 + 노즐 + 물받이 + 버튼/표시등"""
    w, d, h = mm(200), mm(430), mm(420)
    B.box("Purifier", (cx, cy, top + h / 2), (w, d, h), M["purifier"], 0.03)
    yf = cy - d / 2
    # 출수부 (앞면 아래쪽 어두운 오목면 + 노즐 + 물받이)
    B.box("PurifierNook", (cx, yf + mm(2), top + mm(125)), (w * 0.62, mm(6), mm(110)), M["purifier_dark"], 0.01)
    B.cyl("PurifierNozzle", (cx, yf + mm(30), top + mm(165)), mm(9), mm(30), M["steel"], bevel=0.0, segs=16)
    B.box("PurifierTray", (cx, yf - mm(25), top + mm(10)), (w * 0.8, mm(60), mm(16)), M["purifier_dark"], 0.006)
    # 버튼 + 표시등
    for k, mat in enumerate(("blue_light", "purifier_btn", "purifier_btn")):
        B.cyl(f"PurifierBtn{k}", (cx - mm(50) + mm(50) * k, yf - mm(1), top + mm(330)), mm(13), mm(6),
              M[mat], bevel=0.0, segs=20).rotation_euler = (math.radians(90), 0, 0)
    B.box("PurifierLogo", (cx, yf - mm(1), top + mm(375)), (mm(90), mm(3), mm(14)), M["blue_light"], 0.002)


def drying_rack(B, M, cx, cy, top):
    """팔레트/붓 말리는 건조대"""
    w, d = mm(560), mm(300)
    B.box("RackTray", (cx, cy, top + mm(15)), (w, d, mm(30)), M["rack"], 0.01)
    # 세로 살 (팔레트 끼우는 칸)
    n = 7
    for i in range(n):
        x = cx - w / 2 + mm(40) + (w - mm(80)) * i / (n - 1)
        for k, yy in enumerate((cy - d / 2 + mm(30), cy + d / 2 - mm(30))):
            B.cyl(f"RackPin{i}_{k}", (x, yy, top + mm(30) + mm(110)), mm(5), mm(220), M["rack"], bevel=0.0, segs=8)
    # 세워 말리는 팔레트 3장 (흰 판 + 물감 자국)
    paints = ("red", "yellow", "blue", "green", "purple", "pot")
    for i, dx in enumerate((mm(-150), mm(-40), mm(80))):
        px = cx + dx
        pw, ph = mm(250), mm(330)
        B.box(f"Palette{i}", (px, cy, top + mm(30) + ph / 2), (mm(8), pw, ph), M["palette"], mm(25))
        # 앞면(-x 쪽)에 물감 자국: 동그란 칸 6개
        for j in range(6):
            r = mm(22) + mm(4) * ((i + j) % 3)
            B.ball(f"PalettePaint{i}_{j}", (px - mm(5), cy - pw / 2 + mm(55) + (j % 3) * mm(70),
                                            top + mm(30) + ph * (0.62 - 0.3 * (j // 3))),
                   (mm(3), r, r), M[paints[(i + j) % len(paints)]])


def brush_cup(B, M, cx, cy, top):
    """붓꽂이 컵 + 붓 (자루 색 다양, 털끝 위로)"""
    B.cyl("BrushCup", (cx, cy, top + mm(65)), mm(45), mm(130), M["cup"], bevel=0.004, r2=mm(40), segs=24)
    cols = ("red", "yellow", "blue", "green", "purple")
    for i in range(5):
        a = 2 * math.pi * i / 5
        lean = Vector((math.cos(a), math.sin(a), 0)) * mm(40)
        base = Vector((cx + math.cos(a) * mm(18), cy + math.sin(a) * mm(18), top + mm(20)))
        tip = base + Vector((0, 0, mm(230))) + lean
        tube(B, f"Brush{i}", [base, base.lerp(tip, 0.5), tip], mm(5), M[cols[i]], segs=8)
        ferrule = tip + (tip - base).normalized() * mm(15)
        tube(B, f"BrushFerrule{i}", [tip, ferrule], mm(5.5), M["steel"], segs=8)
        bristle = ferrule + (tip - base).normalized() * mm(28)
        tube(B, f"BrushHair{i}", [ferrule, ferrule.lerp(bristle, 0.5), bristle], mm(4), M["brush_hair"], segs=8)


def lying_brushes(B, M, cx, cy, top):
    """수건 위에 눕혀 말리는 붓"""
    B.box("DryTowel", (cx, cy, top + mm(4)), (mm(260), mm(160), mm(8)), M["towel"], 0.004)
    cols = ("blue", "red", "yellow")
    for i in range(3):
        y = cy - mm(45) + mm(45) * i
        a = Vector((cx - mm(110), y, top + mm(14)))
        b = Vector((cx + mm(70), y + mm(8), top + mm(14)))
        tube(B, f"LyingBrush{i}", [a, a.lerp(b, 0.5), b], mm(5), M[cols[i]], segs=8)
        c = b + Vector((mm(18), 0, 0))
        tube(B, f"LyingFerrule{i}", [b, c], mm(5.5), M["steel"], segs=8)
        tube(B, f"LyingHair{i}", [c, c + Vector((mm(30), 0, 0))], mm(4), M["brush_hair"], segs=8)


# ---------- 어린이 발판 (폭 40 × 깊이 38 × 높이 33cm, 2단) ----------
STOOL_W, STOOL_D, STOOL_H = 400, 380, 330    # mm
STEP1_Z, STEP2_Z = 150, 255                  # 아래 / 위 발판 윗면 높이 (mm)


def step_stool(B, M, cx, cy):
    """노란 2단 발판: 손잡이 구멍이 있는 옆판 2장 + 발판 2장 + 앞 가림판. 높은 단이 +y(싱크대) 쪽"""
    y0 = cy - mm(STOOL_D) / 2           # 앞(낮은 단 쪽)
    T = mm(18)
    mat = M["stool"]
    # 옆판 윤곽 (앞→뒤 y, 높이 z) : 앞은 낮은 단 높이, 곡선으로 올라가 뒤쪽 위가 둥근 귀 모양
    prof = [(0, 0), (0, STEP1_Z + 15)]
    for i in range(1, 9):                  # 낮은 단에서 높은 단으로 오목하게 올라가는 곡선
        a = math.pi / 2 * i / 8
        prof.append((40 + 150 * (1 - math.cos(a)), STEP1_Z + 15 + (STOOL_H - STEP1_Z - 70) * math.sin(a) ** 1.4))
    for i in range(0, 9):                  # 뒤쪽 위 둥근 귀
        a = math.pi * i / 8
        prof.append((265 + 55 * (1 - math.cos(a)), STOOL_H - 35 + 35 * math.sin(a)))
    prof += [(STOOL_D, STOOL_H - 35), (STOOL_D, 0)]
    for i in range(8, -1, -1):            # 바닥 아치형 틈
        a = math.pi * i / 8
        prof.append((70 + 120 * (1 - math.cos(a)), 55 * math.sin(a)))
    pts = [(cy - mm(STOOL_D) / 2 + mm(y), mm(z)) for y, z in prof]
    for k, sxs in enumerate((-1, 1)):
        x = cx + sxs * (mm(STOOL_W) / 2 - T / 2)
        bm = bmesh.new()
        a_ = [bm.verts.new((x - T / 2, y, z)) for y, z in pts]
        b_ = [bm.verts.new((x + T / 2, y, z)) for y, z in pts]
        bm.faces.new(a_)
        bm.faces.new(list(reversed(b_)))
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a_[i], a_[j], b_[j], b_[i]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        side = B.obj(f"StoolSide{k}", bm, mat, smooth=False)
        # 손잡이 구멍 (옆판을 관통하는 긴 타원 기둥으로 뚫고 바로 굳힘)
        hb = bmesh.new()
        hole = []
        for i in range(24):
            a = 2 * math.pi * i / 24
            hole.append((y0 + mm(320) + mm(32) * math.cos(a), mm(STOOL_H - 38) + mm(13) * math.sin(a)))
        ha = [hb.verts.new((x - T, y, z)) for y, z in hole]
        hc = [hb.verts.new((x + T, y, z)) for y, z in hole]
        hb.faces.new(ha)
        hb.faces.new(list(reversed(hc)))
        for i in range(24):
            j = (i + 1) % 24
            hb.faces.new((ha[i], ha[j], hc[j], hc[i]))
        bmesh.ops.recalc_face_normals(hb, faces=hb.faces)
        hme = bpy.data.meshes.new("StoolHoleCutter")
        hb.to_mesh(hme)
        hb.free()
        cutter = bpy.data.objects.new("StoolHoleCutter", hme)
        bpy.context.scene.collection.objects.link(cutter)
        mod = side.modifiers.new("Hole", "BOOLEAN")
        mod.operation, mod.object, mod.solver = "DIFFERENCE", cutter, "EXACT"
        side.modifiers.move(len(side.modifiers) - 1, 0)
        dg = bpy.context.evaluated_depsgraph_get()
        dg.update()
        baked = bpy.data.meshes.new_from_object(side.evaluated_get(dg))
        old = side.data
        side.modifiers.remove(side.modifiers["Hole"])
        side.data = baked
        bpy.data.meshes.remove(old)
        bpy.data.objects.remove(cutter)
        bpy.data.meshes.remove(hme)
    inner = mm(STOOL_W) - 2 * T
    # 낮은 단 / 높은 단 발판 + 앞 가림판
    for k, (ya, yb, ztop) in enumerate(((0, 190, STEP1_Z), (185, STOOL_D, STEP2_Z))):
        yc = y0 + mm((ya + yb) / 2)
        B.box(f"StoolStep{k}", (cx, yc, mm(ztop) - T / 2), (inner + mm(4), mm(yb - ya), T), mat, mm(4))
        B.box(f"StoolApron{k}", (cx, y0 + mm(ya) + mm(12), mm(ztop) - T - mm(30)), (inner, mm(16), mm(60)),
              mat, mm(3))
    # 나사 자리 (작은 점)
    for k, sxs in enumerate((-1, 1)):
        for j, (yy, zz) in enumerate(((100, 120), (260, 225), (320, 225))):
            B.ball(f"StoolScrew{k}{j}", (cx + sxs * (mm(STOOL_W) / 2 + mm(1)), y0 + mm(yy), mm(zz)),
                   (mm(2), mm(5), mm(5)), M["steel_dark"])


# ---------- 책상 + 의자 (줄무늬 기둥 벽에서 1.5m) ----------
TABLE_L, TABLE_W, TABLE_H = mm(2350), mm(1000), mm(740)
TABLE_TOP_T = mm(40)
TABLE_FOOT_L, TABLE_FOOT_W = mm(1900), mm(800)      # 다리 아래 바깥 치수
TABLE_RAIL_Z = mm(270)                               # 아래 가로대 높이
LEG_S = mm(60)                                       # 다리 굵기
TABLE_GAP = mm(1500)                                 # 벽에서 책상 가장자리까지
TABLE_X = -ROOM_W / 2 + TABLE_GAP + TABLE_L / 2      # 책상 중심 x (90도 돌려 긴 쪽이 x 방향)
TABLE_Y = PILLAR_Y                                   # 기둥과 같은 앞뒤 위치
DEFAULT_DOLL_SPOT = (2.6 * SX, -3.6)                 # 기본 인형 자리 (layout.json 의 doll_spot 이 우선)


def oriented_box(B, name, center, size, mat, rot=None, bevel=0.006):
    bm = bmesh.new()
    R = (rot if rot is not None else Matrix.Identity(3)).to_4x4()
    m = Matrix.Translation(center) @ R @ Matrix.Diagonal((*size, 1))
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    return B.obj(name, bm, mat, bevel=bevel, smooth=False)


def beam(B, name, p0, p1, w, h, mat, bevel=0.004):
    """p0→p1 방향으로 늘린 각재 (단면 w×h)"""
    d = p1 - p0
    rot = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix()
    return oriented_box(B, name, (p0 + p1) / 2, (w, h, d.length), mat, rot, bevel)


def build_table(B, M, cx, cy):
    """트레슬 책상: 원목 줄무늬 상판 + 검정 다리 (끝마다 비스듬한 다리 2개 + 위아래 가로대, 가운데 긴 가로대 + V자 버팀대)"""
    top_z = TABLE_H - TABLE_TOP_T / 2
    B.box("TableTop", (cx, cy, top_z), (TABLE_W, TABLE_L, TABLE_TOP_T), M["acacia"], bevel=0.01)
    under = TABLE_H - TABLE_TOP_T
    rail_z = TABLE_RAIL_Z
    ends = []
    for k, sy in enumerate((-1, 1)):
        foot_y = cy + sy * (TABLE_FOOT_L / 2 - LEG_S / 2)
        top_y = cy + sy * (TABLE_L / 2 - mm(170))
        legs = []
        for j, sx in enumerate((-1, 1)):
            foot = Vector((cx + sx * (TABLE_FOOT_W / 2 - LEG_S / 2), foot_y, 0.0))
            head = Vector((cx + sx * (TABLE_W / 2 - mm(110)), top_y, under))
            beam(B, f"TableLeg{k}{j}", foot, head, LEG_S, LEG_S, M["table_black"])
            legs.append((foot, head))
        # 위 가로대 (상판 아래) / 아래 가로대 (27cm)
        B.box(f"TableApron{k}", (cx, top_y, under - mm(40)), (TABLE_W - mm(160), mm(50), mm(80)),
              M["table_black"], 0.004)
        t = rail_z / under
        pa = legs[0][0].lerp(legs[0][1], t)
        pb = legs[1][0].lerp(legs[1][1], t)
        beam(B, f"TableRail{k}", pa - Vector((mm(40), 0, 0)), pb + Vector((mm(40), 0, 0)), mm(50), mm(60),
             M["table_black"])
        # 쐐기 장식
        for j, pp in enumerate((pa, pb)):
            B.box(f"TableWedge{k}{j}", (pp.x + (-1 if j == 0 else 1) * mm(55), pp.y, pp.z + mm(10)),
                  (mm(25), mm(20), mm(90)), M["table_black"], 0.003)
        ends.append((Vector((cx, (pa.y + pb.y) / 2, rail_z)), top_y))
    # 가운데 긴 가로대
    beam(B, "TableStretcher", ends[0][0], ends[1][0], mm(60), mm(70), M["table_black"])
    # V자 버팀대: 긴 가로대 가운데에서 상판 아래 양끝 가까이로
    mid = Vector((cx, cy, rail_z + mm(35)))
    for k, (_, top_y) in enumerate(ends):
        tgt = Vector((cx, cy + (top_y - cy) * 0.62, under - mm(20)))
        beam(B, f"TableBrace{k}", mid, tgt, mm(45), mm(55), M["table_black"])
    B.box("TableBeam", (cx, cy, under - mm(30)), (mm(60), TABLE_L - mm(500), mm(60)), M["table_black"], 0.004)


def rect_sweep(B, name, pts, w, h, mat, bevel=0.004):
    """사각 단면(가로 w, 세로 h)을 곡선을 따라 한 덩어리로 늘림 (의자 등받이 윗대)"""
    up = Vector((0, 0, 1))
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(pts):
        a, b = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
        t = (b - a).normalized()
        side = up.cross(t).normalized()
        rings.append([bm.verts.new(p + side * (sx * w / 2) + up * (sz * h / 2))
                      for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    for ra, rb in zip(rings[:-1], rings[1:]):
        for k in range(4):
            j = (k + 1) % 4
            bm.faces.new((ra[k], ra[j], rb[j], rb[k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return B.obj(name, bm, mat, bevel=bevel, smooth=False)


def build_junior_chair(B, M, name, T, mat):
    """어린이 높은 의자: 좌판 29×28cm @52cm, 다리 벌어짐 43×41cm, 발받침 가로대, 등받이 살 4개 + 휜 윗대 (높이 79cm)"""
    R = T.to_3x3()

    def w(x, y, z):
        return T @ Vector((x, y, z))
    seat_z = mm(520)
    sw, sd, st = mm(290), mm(280), mm(22)
    oriented_box(B, f"{name}_Seat", w(0, 0, seat_z - st / 2), (sw, sd, st), mat, R, bevel=mm(8))
    fw, fd = mm(430), mm(410)
    legs = []
    for i, (sx, sy) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
        top = w(sx * (sw / 2 - mm(30)), sy * (sd / 2 - mm(30)), seat_z - st)
        foot = w(sx * (fw / 2 - mm(20)), sy * (fd / 2 - mm(20)), 0.0)
        tube(B, f"{name}_Leg{i}", [foot, top], mm(15), mat, segs=10)
        legs.append((foot, top))
    # 발받침 가로대 (앞) + 옆 가로대
    for i, (a, b, h) in enumerate(((0, 1, 0.38), (0, 2, 0.24), (1, 3, 0.24))):
        pa = legs[a][0].lerp(legs[a][1], h)
        pb = legs[b][0].lerp(legs[b][1], h)
        tube(B, f"{name}_Rung{i}", [pa, pb], mm(11), mat, segs=10)
    # 등받이: 살 4개 (살짝 뒤로 기울고 위로 갈수록 벌어짐) + 휜 윗대
    back_y = sd / 2 - mm(25)
    top_z = mm(790) - mm(25)
    for i in range(4):
        u = (i - 1.5) / 1.5
        a = w(u * mm(85), back_y, seat_z)
        b = w(u * mm(125), back_y + mm(55), top_z - mm(20))
        tube(B, f"{name}_Spindle{i}", [a, b], mm(10), mat, segs=10)
    pts = [w(u * mm(175), back_y + mm(55) + mm(25) * (1 - u * u), top_z) for u in [i / 8 - 1 for i in range(17)]]
    rect_sweep(B, f"{name}_TopRail", pts, mm(24), mm(55), mat)


def build_windsor_chair(B, M, name, T, mat):
    """윈저 의자: 좌판 44×39cm @46cm (둥근 안장형), 다리 벌어짐 43×46cm + H 가로대, 둥근 아치 등받이 + 살 7개 (높이 94cm)"""
    R = T.to_3x3()

    def w(x, y, z):
        return T @ Vector((x, y, z))
    seat_z = mm(460)
    sw, sd, st = mm(440), mm(390), mm(35)
    # 둥근 좌판: 원통을 타원으로 눌러 사용
    bm = bmesh.new()
    m = T @ Matrix.Translation((0, 0, seat_z - st / 2)) @ Matrix.Diagonal((sw / 2, sd / 2, 1, 1))
    bmesh.ops.create_cone(bm, cap_ends=True, segments=40, radius1=1.0, radius2=1.0, depth=st, matrix=m)
    B.obj(f"{name}_Seat", bm, mat, bevel=mm(8), smooth=False)
    fw, fd = mm(430), mm(460)
    legs = []
    for i, (sx, sy) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
        top = w(sx * (sw / 2 - mm(70)), sy * (sd / 2 - mm(60)), seat_z - st)
        foot = w(sx * (fw / 2 - mm(25)), sy * (fd / 2 - mm(25)), 0.0)
        tube(B, f"{name}_Leg{i}", [foot, top], mm(16), mat, segs=10)
        legs.append((foot, top))
    # H 가로대
    h = 0.3
    side = []
    for i, (a, b) in enumerate(((0, 2), (1, 3))):
        pa, pb = legs[a][0].lerp(legs[a][1], h), legs[b][0].lerp(legs[b][1], h)
        tube(B, f"{name}_SideRung{i}", [pa, pb], mm(11), mat, segs=10)
        side.append((pa + pb) / 2)
    tube(B, f"{name}_MidRung", side, mm(11), mat, segs=10)
    # 아치 등받이 (뒤로 약간 기움) + 살 7개
    # 아치 양 끝은 좌판 안쪽(뒤쪽 모서리)에 꽂히고, 위로 올라가며 조금 넓어졌다가 둥글게 넘어감
    by = mm(105)                    # 아치/살이 꽂히는 좌판 앞뒤 위치 (좌판 타원 안쪽)
    bw0, bw = mm(160), mm(210)      # 아치 아래 끝 반폭 / 최대 반폭
    top_h = mm(940) - seat_z
    sink = mm(15)                   # 좌판 속으로 꽂히는 깊이

    def arch_pt(a, drop=0.0):
        zz = top_h * math.sin(a) ** 0.35
        half = bw0 + (bw - bw0) * math.sin(a) ** 0.5
        return w(-half * math.cos(a), by + zz * 0.18, seat_z - sink + zz - drop)

    arch = [arch_pt(math.pi * i / 32) for i in range(33)]
    tube(B, f"{name}_Bow", arch, mm(13), mat, segs=10)
    Ti = T.inverted()
    for i in range(7):
        a = math.pi * (i + 1) / 8
        top = arch_pt(a, drop=mm(4))
        lx = (Ti @ top).x
        tube(B, f"{name}_Spindle{i}", [w(lx * 0.75, by, seat_z - sink), top], mm(7), mat, segs=8)


# ---------- 우측벽: 통유리 + 길게 뻗은 세로 샷시 ----------
SASH = mm(900)                 # 세로 샷시 간격 (약 90cm)


def build_right_glass_wall(B, M):
    W, H, T = ROOM_W, ROOM_H, WALL_T
    xw = W / 2                                  # 벽 안쪽 면
    gx = xw + T / 2
    B.box("RGlass", (gx, 0, H / 2), (0.03, ROOM_D, H), M["glass"], bevel=0.0)
    # 위/아래 틀
    B.box("RGlassTop", (xw + 0.02, 0, H - 0.06), (0.2, ROOM_D, 0.12), M["trim"], 0.015)
    B.box("RGlassBottom", (xw + 0.02, 0, 0.05), (0.22, ROOM_D, 0.1), M["trim"], 0.015)
    # 세로 샷시: 바닥부터 천장까지 길게
    n = max(1, round(ROOM_D / SASH))
    for k in range(n + 1):
        y = FRONT_Y + ROOM_D * k / n
        y = min(max(y, FRONT_Y + 0.06), BACK_Y - 0.06)
        B.box(f"RSash{k}", (xw + 0.02, y, H / 2), (0.16, 0.12 if 0 < k < n else 0.1, H), M["trim"], 0.02)
    # 앞뒤 모서리 기둥: 왼쪽과 같은 분홍 기둥 (방 안쪽으로 PIL_D 만큼)
    B.box("RPier", (xw - PIL_D / 2 + T / 2, FRONT_Y + PIER_W / 2, H / 2), (PIL_D + T, PIER_W, H), M["pillar_p"], 0.03)
    B.box("RPierBack", (xw - PIL_D / 2 + T / 2, BACK_Y - PIER_W / 2 + T / 2, H / 2),
          (PIL_D + T, PIER_W + T, H), M["pillar_p"], 0.03)

def build_corridor(B, M):
    """오른쪽 유리벽 밖 상가 복도. 밖이 아니라 건물 안이라 시간과 상관없이 늘 같은 밝기다.
    천장 높이는 미술실과 같게 맞춘다 (달라지면 유리벽 위에 띠가 생겨 어색하다).
    맞은편도 미술실과 같은 통유리벽이고 검은 시트지가 붙어 있다. 하늘이 새어 보이지 않게 앞뒤도 막는다."""
    H, T = ROOM_H, WALL_T
    x0 = ROOM_W / 2 + T                           # 미술실 유리벽 바깥면
    x1 = x0 + CORR_W                              # 맞은편 통유리벽
    y0, y1 = FRONT_Y - 5.0, BACK_Y + 2.0          # 방보다 앞뒤로 길게 (끝이 안 보이게)
    cy, cd = (y0 + y1) / 2, y1 - y0
    cx, cw = (x0 + x1) / 2, x1 - x0
    B.box("CorrFloor", (cx, cy, -T / 2), (cw, cd, T), M["corr_floor"], bevel=0.0)
    B.box("CorrCeil", (cx, cy, H + T / 2), (cw, cd, T), M["corr_ceil"], bevel=0.0)
    B.box("CorrEndFront", (cx, y0 - T / 2, H / 2), (cw, T, H), M["corr_wall"], bevel=0.0)
    B.box("CorrEndBack", (cx, y1 + T / 2, H / 2), (cw, T, H), M["corr_wall"], bevel=0.0)
    # 복도 천장 매립등 (길게 줄지어)
    n = max(3, int(cd / 3.2))
    for k in range(n):
        y = y0 + cd * (k + 0.5) / n
        B.box(f"CorrLight{k}", (cx, y, H - mm(20)), (mm(900), mm(260), mm(40)), M["corr_light"], bevel=0.0)
    # 맞은편 통유리벽 (검은 시트지) + 미술실 유리벽과 같은 모양의 틀·세로 샷시
    B.box("CorrGlass", (x1, cy, H / 2), (0.05, cd, H), M["film_glass"], bevel=0.0)
    B.box("CorrGlassTop", (x1 - 0.02, cy, H - 0.06), (0.2, cd, 0.12), M["trim"], 0.015)
    B.box("CorrGlassBottom", (x1 - 0.02, cy, 0.05), (0.22, cd, 0.1), M["trim"], 0.015)
    ns = max(1, round(cd / SASH))
    for k in range(ns + 1):
        y = min(max(y0 + cd * k / ns, y0 + 0.06), y1 - 0.06)
        B.box(f"CorrSash{k}", (x1 - 0.02, y, H / 2), (0.16, 0.12 if 0 < k < ns else 0.1, H), M["trim"], 0.02)


# =====================================================================
# 가구 = 배치 가능한 항목 (layout.json 으로 위치/회전/교체/해제)
# =====================================================================
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
# 방 종류: 같은 크기의 방 두 개. 파일 이름 접두어로 렌더/내보내기 결과를 구분
ROOMS = {
    "classroom": dict(name="미술실", layout="layout.json", prefix="map", export="map_room",
                      shell="room_shell.glb", blend="map.blend", daylight=True),
    # 전시장은 창이 없어 시간대와 상관없이 늘 같은 빛이다 (daylight=False → 한 장만 렌더)
    "gallery": dict(name="전시장", layout="layout_gallery.json", prefix="map_gallery", export="map_gallery",
                    shell="room_shell_gallery.glb", blend="map_gallery.blend", daylight=False),
}


def room_phases(room=None):
    """그 방이 쓰는 시간대 목록. 창이 없는 방은 기본 하나뿐"""
    r = ROOMS.get(room or CURRENT_ROOM, {})
    return list(phases.ORDER) if r.get("daylight") else [phases.DEFAULT]
CURRENT_ROOM = os.environ.get("MAP_ROOM", "classroom")
if CURRENT_ROOM not in ROOMS:
    CURRENT_ROOM = "classroom"
ROOM_PREFIX = ROOMS[CURRENT_ROOM]["prefix"]
ROOM_EXPORT = ROOMS[CURRENT_ROOM]["export"]
LAYOUT_PATH = os.path.join(PROJECT_DIR, ROOMS["classroom"]["layout"])
ITEM_TYPES = {}          # type id → {id, name, category, back, mounts, build}


def item_type(type_id, name, category, back=None, mounts=None):
    """가구 종류 등록. build(B, M) 는 기본 위치에 만들고 기준점 (x, y) 을 돌려준다.
    back: 가구 뒤쪽 방향 (벽에 붙일 때 벽을 향하는 쪽, 가구 자체 좌표 기준)
    mounts: 그림을 걸 수 있는 면 목록 (또는 그 목록을 돌려주는 함수). 가구 좌표 기준
        origin = 면의 아래쪽 가운데, normal = 면이 바라보는 방향, up = 면의 위 방향,
        width/height = 면 크기, ledge = 받침대 위에 올려놓는 방식(이젤), hides = 그림을 걸면 숨길 부품 이름 접두어"""
    def deco(fn):
        ITEM_TYPES[type_id] = dict(id=type_id, name=name, category=category, back=back, build=fn,
                                   mounts=mounts)
        return fn
    return deco


def _round_vec(v):
    return [round(float(c), 5) for c in v]


def type_mounts(type_id):
    t = ITEM_TYPES.get(type_id)
    if not t or not t.get("mounts"):
        return []
    ms = t["mounts"]() if callable(t["mounts"]) else t["mounts"]
    out = []
    for m in ms:
        m = dict(m)
        for k in ("origin", "normal", "up"):
            m[k] = _round_vec(m[k])
        m.setdefault("ledge", False)
        m.setdefault("hides", [])
        m.setdefault("default_size", 0.9)
        out.append(m)
    return out


def find_mount(type_id, mount_id):
    return next((m for m in type_mounts(type_id) if m["id"] == mount_id), None)


def mount_spec(mid, name, origin, normal, width, height, ledge=False, default_size=0.9, hides=(),
               up=(0.0, 0.0, 1.0)):
    return dict(id=mid, name=name, origin=tuple(origin), normal=tuple(normal), up=tuple(up), width=width,
                height=height, ledge=ledge, default_size=default_size, hides=list(hides))


def pose_matrix(x, y, rot_deg):
    return Matrix.Translation((x, y, 0.0)) @ Matrix.Rotation(math.radians(rot_deg), 4, "Z")


def make_item(B, M, link, entry, hide=()):
    """가구 하나를 만들고 빈 오브젝트(ITEM_<id>) 아래로 묶어 배치 위치로 옮긴다.
    hide: 이름이 이 접두어로 시작하는 부품은 만들지 않음 (그림이 걸린 이젤의 원래 캔버스 등)"""
    t = ITEM_TYPES[entry["type"]]
    first = len(B.objs)
    ax, ay = t["build"](B, M)
    parts = B.objs[first:]
    if hide:
        keep = []
        for o in parts:
            if any(o.name.startswith(pfx) for pfx in hide):
                bpy.data.objects.remove(o)
            else:
                keep.append(o)
        del B.objs[first:]
        B.objs.extend(keep)
        parts = keep
    emp = bpy.data.objects.new(f"ITEM_{entry['id']}", None)
    emp.empty_display_type = "PLAIN_AXES"
    emp.empty_display_size = 0.4
    emp["item_id"] = entry["id"]
    emp["item_type"] = entry["type"]
    link(emp)
    inv = Matrix.Translation((-ax, -ay, 0.0))
    for o in parts:
        o.parent = emp
        o.matrix_parent_inverse = inv
    emp.matrix_basis = pose_matrix(entry.get("x", ax), entry.get("y", ay), entry.get("rot", 0.0))
    B.objs.append(emp)
    return emp, parts


# ---------- 가구 종류 ----------
def _left_wall_refs():
    xw = -ROOM_W / 2
    pf, pb = PILLAR_Y - PIL_W / 2, PILLAR_Y + PIL_W / 2
    return xw, pf, pb, FRONT_Y + PIER_W


@item_type("cabinet_left", "좌측장 (선반·서류트레이·열린칸)", "수납장", back=(-1, 0))
def _it_cabinet_left(B, M):
    xw, pf, pb, y_front = _left_wall_refs()
    build_left_cabinet(B, M, xw, pf, mirror_c=2 * pf)
    for k in range(3):
        B.cyl(f"PaperRoll_{k}", (xw + 0.2 + 0.18 * k, y_front + mm(160), CAB_H * 0.75), 0.07, CAB_H * 0.9,
              M[("yellow", "blue", "red")[k]], bevel=0.0, segs=16)
    B.ball("CabBall", (xw + 0.45, pf - 0.9, CAB_H + 0.2), (0.2, 0.2, 0.2), M["purple"])
    B.cyl("CabVase", (xw + 0.45, pf - 2.2, CAB_H + 0.3), 0.15, 0.56, M["pot"], r2=0.11)
    B.ball("CabVaseLeaf", (xw + 0.45, pf - 2.2, CAB_H + 0.76), (0.17, 0.17, 0.3), M["green"])
    return xw + CAB_D / 2, (y_front + pf) / 2


@item_type("cabinet_right", "우측장 (선반·비스듬 칸막이)", "수납장", back=(-1, 0))
def _it_cabinet_right(B, M):
    xw, pf, pb, y_front = _left_wall_refs()
    build_right_cabinet(B, M, xw, 0.0, mirror_c=pb + RCAB_LEN)
    sb = pb + mm(1038 * 2)
    for k, (dy, h, mat) in enumerate(((0.1, 0.9, "red"), (0.2, 0.8, "yellow"), (0.32, 0.95, "blue"),
                                      (0.95, 0.85, "purple"), (1.07, 0.9, "red"), (1.72, 0.8, "yellow"))):
        B.box(f"SlantBook_{k}", (xw + 0.42, sb + dy, BOARD + h * CAB_H * 0.45), (0.55, 0.08, h * CAB_H * 0.9),
              M[mat], 0.01)
    for k in range(3):
        B.box(f"ShelfBasket_{k}", (xw + 0.42, pb + mm(1038) * (1 + (k + 0.5) / 3), BOARD + 0.18),
              (0.55, mm(1038) / 3 - 0.12, 0.34), M[("yellow", "red", "blue")[k]], 0.04)
    B.ball("ShelfToy", (xw + 0.42, pb + mm(600), CAB_H * 0.55 + 0.2), (0.18, 0.18, 0.18), M["purple"])
    B.cyl("CabGlobeStand", (xw + 0.45, pb + 1.0, CAB_H + 0.1), 0.14, 0.2, M["cab_dark"], r2=0.08)
    B.ball("CabGlobe", (xw + 0.45, pb + 1.0, CAB_H + 0.52), (0.3, 0.3, 0.3), M["blue"])
    return xw + CAB_D / 2, pb + RCAB_LEN / 2


def _sink_refs():
    right_x0 = ROOM_W / 2 - BASE_W
    left_x0 = right_x0 - BASE_W
    lcx = left_x0 + BASE_W / 2
    hx0, hx1 = lcx + mm(30), lcx + mm(30) + mm(360)
    hy0 = BACK_Y - BASE_D + mm(110)
    return right_x0, left_x0, lcx, (hx0, hx1, hy0, hy0 + mm(380))


@item_type("sink_cabinet", "싱크대 하부장 (싱크볼·코브라수전·정수기)", "주방", back=(0, 1))
def _it_sink(B, M):
    right_x0, left_x0, lcx, (hx0, hx1, hy0, hy1) = _sink_refs()
    base_cabinet(B, M, "SinkCab", left_x0, top_hole=(hx0, hx1, hy0, hy1))
    sink_bowl(B, M, hx0, hx1, hy0, hy1, mm(190))
    cobra_faucet(B, M, (hx0 + hx1) / 2, hy1 + mm(55), BASE_H)
    water_purifier(B, M, lcx - mm(300), BACK_Y - mm(260), BASE_H)
    return lcx, BACK_Y - BASE_D / 2


@item_type("drying_cabinet", "건조대 하부장 (팔레트·붓)", "주방", back=(0, 1))
def _it_drying(B, M):
    right_x0 = ROOM_W / 2 - BASE_W
    rcx, _, _ = base_cabinet(B, M, "DryCab", right_x0)
    drying_rack(B, M, rcx - mm(80), BACK_Y - mm(200), BASE_H)
    brush_cup(B, M, rcx + mm(430), BACK_Y - mm(150), BASE_H)
    lying_brushes(B, M, rcx + mm(260), BACK_Y - mm(470), BASE_H)
    return rcx, BACK_Y - BASE_D / 2


@item_type("step_stool", "어린이 발판 (노랑)", "주방", back=(0, 1))
def _it_stool(B, M):
    step_stool(B, M, 0.0, 0.0)
    return 0.0, 0.0


@item_type("table", "트레슬 책상 235×100", "책상·의자")
def _it_table(B, M):
    build_table(B, M, 0.0, 0.0)
    return 0.0, 0.0


@item_type("junior_chair_red", "어린이 높은 의자 (빨강)", "책상·의자", back=(0, 1))
def _it_jchair_red(B, M):
    build_junior_chair(B, M, "JuniorChair", Matrix.Identity(4), M["chair_red"])
    return 0.0, 0.0


@item_type("junior_chair_black", "어린이 높은 의자 (검정)", "책상·의자", back=(0, 1))
def _it_jchair_black(B, M):
    build_junior_chair(B, M, "JuniorChair", Matrix.Identity(4), M["chair_black"])
    return 0.0, 0.0


@item_type("windsor_chair", "윈저 의자 (검정)", "책상·의자", back=(0, 1))
def _it_windsor(B, M):
    build_windsor_chair(B, M, "WindsorChair", Matrix.Identity(4), M["chair_black"])
    return 0.0, 0.0


@item_type("toy_blocks", "장난감 블록 3개", "놀이")
def _it_blocks(B, M):
    for k, (c, mat, rot) in enumerate((((-0.35 * SX, -0.1, 0.3), "red", 8), ((0.35 * SX, 0.1, 0.3), "blue", -12),
                                       ((0.0, 0.0, 0.9), "yellow", 20))):
        b = B.box(f"Block_{k}", c, (0.6, 0.6, 0.6), M[mat], bevel=0.1)
        b.rotation_euler = (0, 0, math.radians(rot))
    return 0.0, 0.0


@item_type("toy_ball", "공 (보라)", "놀이")
def _it_ball(B, M):
    B.ball("ToyBall", (0.0, 0.0, 0.35), (0.35, 0.35, 0.35), M["purple"])
    return 0.0, 0.0


@item_type("plant", "화분", "놀이")
def _it_plant(B, M):
    B.cyl("Pot", (0.0, 0.0, 0.4), 0.45, 0.8, M["pot"], r2=0.55)
    for k in range(6):
        a = k * math.pi / 3
        B.ball(f"Leaf_{k}", (0.32 * math.cos(a), 0.32 * math.sin(a), 1.25),
               (0.18, 0.18, 0.5), M["green"], rot=(0.5 * math.sin(a), -0.5 * math.cos(a), 0))
    B.ball("LeafTop", (0.0, 0.0, 1.4), (0.2, 0.2, 0.55), M["green"])
    return 0.0, 0.0


@item_type("cushion", "방석 (분홍)", "놀이")
def _it_cushion(B, M):
    B.cyl("Cushion", (0.0, 0.0, 0.2), 0.65, 0.35, M["curtain"], bevel=0.14)
    return 0.0, 0.0


@item_type("rug", "러그 (타원)", "놀이")
def _it_rug(B, M):
    rug = B.cyl("Rug", (0.0, 0.0, 0.03), 1.0, 0.06, M["rug"], bevel=0.03, segs=96)
    rug.scale = (2.6, 1.5, 1.0)
    return 0.0, 0.0


def _kid_easel_mounts():
    """어린이 이젤 양쪽 그림판 (앞면 = -y 쪽). 그림을 걸면 그 면의 종이/그림을 숨김"""
    EH, EW, FOOT, APEX, LEG = mm(1200), mm(640), mm(310), mm(40), mm(38)
    theta = math.atan((FOOT - APEX) / EH)
    z0, z1 = mm(460), mm(1130)
    zc = (z0 + z1) / 2
    board_len = (z1 - z0) / math.cos(theta)
    out = []
    for sy in (-1, 1):
        R = Matrix.Rotation(sy * theta, 3, "X")
        nrm = R @ Vector((0, sy, 0))
        up = R @ Vector((0, 0, 1))
        c = Vector((0, sy * (FOOT - (FOOT - APEX) * zc / EH), zc)) + nrm * (LEG / 2 + mm(6))
        front = c + nrm * mm(6)
        out.append(mount_spec(f"side{sy:+d}", "앞면" if sy < 0 else "뒷면", front - up * (board_len / 2), nrm,
                              EW - mm(20), board_len, ledge=True, default_size=0.5, up=up,
                              hides=(f"EaselPaper_{sy}", f"EaselPaint_{sy}_")))
    return out


@item_type("easel", "어린이 이젤 (양면·그림판·물감받침)", "미술", mounts=_kid_easel_mounts)
def _it_easel(B, M):
    """어린이 양면 A자 이젤: 나무 다리 4개 + 위 경첩봉·종이 롤 + 양쪽 그림판(종이+그림) + 물감 받침대(컵·붓)"""
    EH, EW = mm(1200), mm(640)          # 높이 / 폭
    FOOT, APEX = mm(310), mm(40)        # 발 / 꼭대기의 앞뒤 거리 (중심 기준)
    LEG = mm(38)
    wood, board_m = M["wood"], M["cab_door"]
    theta = math.atan((FOOT - APEX) / EH)

    def leg_y(sy, z):
        return sy * (FOOT - (FOOT - APEX) * z / EH)

    for sy in (-1, 1):
        R = Matrix.Rotation(sy * theta, 3, "X")
        nrm = R @ Vector((0, sy, 0))
        # 다리 2개
        for sx in (-1, 1):
            x = sx * (EW / 2 - LEG / 2)
            beam(B, f"EaselLeg_{sy}_{sx}", Vector((x, leg_y(sy, 0), 0)), Vector((x, leg_y(sy, EH), EH)),
                 LEG, LEG, wood, bevel=mm(5))
        # 그림판
        z0, z1 = mm(460), mm(1130)
        zc = (z0 + z1) / 2
        c = Vector((0, leg_y(sy, zc), zc)) + nrm * (LEG / 2 + mm(6))
        oriented_box(B, f"EaselBoard_{sy}", c, (EW - mm(20), mm(12), (z1 - z0) / math.cos(theta)), board_m, R,
                     bevel=mm(4))
        # 종이
        pc = c + nrm * mm(7)
        oriented_box(B, f"EaselPaper_{sy}", pc, (mm(500), mm(2), mm(600)), M["palette"], R, bevel=0.0)
        # 그림: 해 / 언덕 / 꽃 (종이 위 납작한 물감 자국)
        up = R @ Vector((0, 0, 1))
        side = Vector((1, 0, 0))
        # (가로, 세로, 가로 반지름, 세로 반지름, 색) 단위 m
        dots = ((0.14, 0.2, 0.07, 0.07, "yellow"), (-0.12, -0.16, 0.09, 0.055, "green"),
                (0.06, -0.19, 0.08, 0.05, "green"), (-0.1, -0.07, 0.008, 0.09, "green"),
                (-0.1, 0.03, 0.035, 0.035, "red"), (-0.1, 0.03, 0.013, 0.013, "yellow"),
                (0.12, -0.03, 0.028, 0.028, "blue"))
        for k, (u, v, rx, rz, mat) in enumerate(dots):
            q = pc + nrm * mm(3 + k * 0.6) + side * (u * UNIT * sy * -1) + up * (v * UNIT)
            B.ball(f"EaselPaint_{sy}_{k}", q, (rx * UNIT, mm(2), rz * UNIT), M[mat], rot=(sy * theta, 0, 0))
        # 물감 받침대 (그림판 아래, 앞으로 튀어나온 선반 + 턱)
        tz = z0 - mm(10)
        ty = leg_y(sy, tz) + sy * (LEG / 2 + mm(45))
        B.box(f"EaselTray_{sy}", (0, ty, tz), (EW, mm(95), mm(16)), wood, bevel=mm(3))
        B.box(f"EaselTrayLip_{sy}", (0, ty + sy * mm(42), tz + mm(18)), (EW, mm(12), mm(36)), wood, bevel=mm(3))
        for k, mat in enumerate(("red", "yellow", "blue")):
            cx = (k - 1) * mm(90) + mm(90)
            B.cyl(f"EaselCup_{sy}_{k}", (cx, ty, tz + mm(8) + mm(35)), mm(28), mm(70), M["cup"], bevel=mm(3),
                  segs=20)
            B.cyl(f"EaselCupPaint_{sy}_{k}", (cx, ty, tz + mm(8) + mm(71)), mm(23), mm(3), M[mat], bevel=0.0,
                  segs=20)
        bx = -mm(180)
        tube(B, f"EaselBrush_{sy}", [Vector((bx - mm(90), ty, tz + mm(18))), Vector((bx + mm(90), ty, tz + mm(18)))],
             mm(6), M["yellow"], segs=8)
        B.ball(f"EaselBrushTip_{sy}", (bx + mm(105), ty, tz + mm(18)), (mm(20), mm(7), mm(7)), M["brush_hair"])
    # 옆 버팀줄 (앞뒤 다리 연결)
    bz = mm(330)
    for sx in (-1, 1):
        x = sx * (EW / 2 - LEG / 2)
        beam(B, f"EaselBrace_{sx}", Vector((x, leg_y(-1, bz), bz)), Vector((x, leg_y(1, bz), bz)),
             mm(16), mm(16), wood, bevel=mm(3))
    # 위: 경첩봉 + 종이 롤
    tube(B, "EaselHinge", [Vector((-EW / 2, 0, EH - mm(15))), Vector((EW / 2, 0, EH - mm(15)))], mm(12),
         M["steel_dark"], segs=12)
    tube(B, "EaselRoll", [Vector((-mm(270), 0, EH + mm(40))), Vector((mm(270), 0, EH + mm(40)))], mm(45),
         M["palette"], segs=24)
    for sx in (-1, 1):
        B.box(f"EaselRollHolder_{sx}", (sx * mm(290), 0, EH + mm(15)), (mm(16), mm(70), mm(90)), wood, bevel=mm(3))
    return 0.0, 0.0


@item_type("easel_pro", "전문가용 이젤 (H형 스튜디오·캔버스)", "미술", back=(0, 1),
           mounts=[mount_spec("canvas", "캔버스 자리", (0, -mm(138), mm(785)), (0, -1, 0), mm(900), mm(1300),
                              ledge=True, default_size=0.73, hides=("ProCanvas", "ProPaint"))])
def _it_easel_pro(B, M):
    """H형 스튜디오 이젤 (높이 약 2.15m): 바퀴 달린 H 받침 + 기둥 2개 + 높이 조절 중앙 기둥
    + 캔버스 받침/위 고정대 + 뒤 지지대 + 60×73cm 캔버스(풍경화). 캔버스 앞면이 -y"""
    V = Vector
    wood, knob = M["cab_dark"], M["steel_dark"]

    def bx(name, c, size, mat=None, bevel=mm(4)):
        return B.box(name, tuple(mm(v) for v in c), tuple(mm(v) for v in size), mat or wood, bevel=bevel)

    def rod(name, a, b, r, mat, segs=12):
        return tube(B, name, [V(tuple(mm(v) for v in a)), V(tuple(mm(v) for v in b))], mm(r), mat, segs=segs)

    # 받침: 옆 레일 2개 + 앞/뒤 가로대 + 바퀴
    for sx in (-1, 1):
        bx(f"ProBaseRail_{sx}", (sx * 320, 200, 70), (60, 900, 60))
        for yy in (-220, 620):
            B.ball(f"ProCaster_{sx}_{yy}", (mm(sx * 320), mm(yy), mm(20)), (mm(20), mm(20), mm(20)), knob)
    bx("ProBaseFront", (0, 0, 70), (700, 60, 60))
    bx("ProBaseBack", (0, 600, 70), (700, 60, 60))
    # 기둥 2개 + 위/가운데 가로대
    for sx in (-1, 1):
        bx(f"ProUpright_{sx}", (sx * 230, 0, 900), (50, 50, 1600))
    bx("ProTopBar", (0, 0, 1700), (540, 50, 60))
    bx("ProMidBar", (0, 0, 450), (540, 50, 60))
    # 중앙 기둥 (높이 조절)
    bx("ProMast", (0, -55, 1250), (55, 55, 1800))
    # 캔버스 받침 (선반 + 턱 + 기둥 연결 블록 + 조절 손잡이)
    bx("ProTray", (0, -140, 770), (760, 110, 30))
    bx("ProTrayLip", (0, -192, 795), (760, 14, 40))
    bx("ProTrayBracket", (0, -100, 745), (90, 60, 110))
    rod("ProTrayKnobRod", (45, -100, 745), (95, -100, 745), 8, knob)
    B.ball("ProTrayKnob", (mm(100), mm(-100), mm(745)), (mm(18), mm(18), mm(18)), knob)
    # 캔버스 (앞면 y = -162.5)
    bx("ProCanvas", (0, -150, 785 + 365), (600, 25, 730), M["palette"], bevel=mm(3))
    fy = -163.5
    bx("ProPaintSky", (0, fy, 1297.5), (560, 2, 395), M["blue"], bevel=0.0)
    bx("ProPaintField", (0, fy, 952.5), (560, 2, 295), M["green"], bevel=0.0)
    B.ball("ProPaintHill", (mm(-40), mm(fy - 1), mm(1100)), (mm(240), mm(1.5), mm(90)), M["purple"])
    B.ball("ProPaintSun", (mm(160), mm(fy - 2), mm(1400)), (mm(50), mm(1.5), mm(50)), M["yellow"])
    bx("ProPaintTrunk", (-190, fy - 3, 1010), (18, 2, 130), M["cab_in"], bevel=0.0)
    B.ball("ProPaintTree", (mm(-190), mm(fy - 4), mm(1100)), (mm(60), mm(1.5), mm(75)), M["tree_g"])
    bx("ProPaintHouse", (120, fy - 3, 940), (150, 2, 110), M["red"], bevel=0.0)
    B.prism("ProPaintRoof", [(mm(35), mm(0)), (mm(205), mm(0)), (mm(120), mm(70))], mm(fy - 5), mm(2),
            mm(995), M["cab_in"], bevel=0.0)
    bx("ProPaintDoor", (120, fy - 5, 915), (30, 2, 60), M["yellow"], bevel=0.0)
    # 위 고정대 (캔버스 윗변을 누름)
    bx("ProClamp", (0, -135, 1535), (130, 75, 40))
    bx("ProClampBlock", (0, -95, 1545), (80, 60, 90))
    rod("ProClampKnobRod", (40, -95, 1545), (90, -95, 1545), 8, knob)
    B.ball("ProClampKnob", (mm(95), mm(-95), mm(1545)), (mm(18), mm(18), mm(18)), knob)
    # 기둥 높이 조절 크랭크
    rod("ProCrankRod", (28, -55, 560), (90, -55, 560), 8, knob)
    rod("ProCrankArm", (90, -55, 560), (90, -55, 480), 7, knob)
    rod("ProCrankGrip", (90, -55, 480), (125, -55, 480), 10, M["cab_in"])
    # 뒤 지지대
    beam(B, "ProStrut", V((0, mm(25), mm(1500))), V((0, mm(600), mm(100))), mm(40), mm(40), wood, bevel=mm(4))
    # 받침 위 붓 + 물감 튜브
    for k, (xx, mat) in enumerate(((-260, "brush_hair"), (-200, "cab_in"))):
        rod(f"ProBrush_{k}", (xx - 110, -150, 792), (xx + 110, -145, 792), 5, M["yellow"] if k else M["red"], 8)
        B.ball(f"ProBrushTip_{k}", (mm(xx + 125), mm(-145), mm(792)), (mm(22), mm(6), mm(6)), M["brush_hair"])
    for k, mat in enumerate(("blue", "red", "yellow")):
        xx = 200 + k * 45
        rod(f"ProTube_{k}", (xx, -170, 797), (xx + 5, -110, 797), 12, M["palette"], 12)
        rod(f"ProTubeCap_{k}", (xx + 5, -110, 797), (xx + 6, -95, 797), 7, M[mat], 10)
    return 0.0, 0.0


# ---------- 전시장 가구 ----------
PART_T, PART_H = mm(120), mm(2700)          # 가벽 두께 / 높이


def _register_partition(length_m):
    w = length_m * UNIT
    mounts = [mount_spec("front", "앞면", (0, -PART_T / 2, 0), (0, -1, 0), w, PART_H),
              mount_spec("back", "뒷면", (0, PART_T / 2, 0), (0, 1, 0), w, PART_H)]

    @item_type(f"partition_{int(round(length_m * 10))}", f"가벽 {length_m:g}m (양면)", "전시", mounts=mounts)
    def _build(B, M):
        B.box("PartitionBody", (0, 0, PART_H / 2), (w, PART_T, PART_H), M["gwall"], bevel=mm(4))
        B.box("PartitionBase", (0, 0, mm(35)), (w - mm(10), PART_T + mm(8), mm(70)), M["gskirt"], bevel=0.0)
        return 0.0, 0.0


for _len in (1.2, 2.4, 3.6):
    _register_partition(_len)


@item_type("gallery_bench", "전시 벤치", "전시")
def _it_gallery_bench(B, M):
    L, dp, ht = mm(1400), mm(450), mm(450)
    B.box("BenchSeat", (0, 0, ht - mm(40)), (L, dp, mm(80)), M["bench"], bevel=mm(15))
    for sx in (-1, 1):
        B.box(f"BenchLeg_{sx}", (sx * (L / 2 - mm(120)), 0, (ht - mm(80)) / 2), (mm(40), dp - mm(60), ht - mm(80)),
              M["track"], bevel=mm(3))
    return 0.0, 0.0


@item_type("plinth", "전시 좌대 (조각)", "전시")
def _it_plinth(B, M):
    B.box("Plinth", (0, 0, mm(450)), (mm(500), mm(500), mm(900)), M["plinth"], bevel=mm(4))
    B.cyl("PlinthSculptBase", (0, 0, mm(920)), mm(90), mm(40), M["track"], bevel=mm(5), segs=32)
    B.ball("PlinthSculpt", (0, 0, mm(1090)), (mm(110), mm(110), mm(150)), M["pot"])
    B.ball("PlinthSculptTop", (mm(20), 0, mm(1270)), (mm(55), mm(55), mm(55)), M["yellow"])
    return 0.0, 0.0


# ---------- 그림 (편집기에서 올린 이미지를 벽/가벽/이젤에 건다) ----------
ART_DEPTH = mm(30)
ART_FRAMES = {          # 액자 폭 / 액자 깊이 / 재질
    "canvas": (0.0, 0.0, None),
    "black": (mm(20), mm(38), "frame_black"),
    "wood": (mm(40), mm(42), "frame_wood"),
    "white": (mm(30), mm(38), "frame_white"),
}


def mat_image(path):
    """그림 이미지 재질. 게임 내보내기에서도 텍스처를 유지(game_keep)"""
    name = "Art_" + os.path.basename(path)
    m = bpy.data.materials.get(name)
    if m:
        return m
    img = bpy.data.images.load(path, check_existing=True)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], p.inputs["Base Color"])
    p.inputs["Roughness"].default_value = 0.6
    p.inputs["Sheen Weight"].default_value = 0.0
    m["game_keep"] = 1
    return m


def make_art(B, M, art):
    """그림 한 점. art["pose"] = 편집기가 계산한 위치 (c: 그림 뒷면 가운데, n: 앞 방향, up: 위 방향)"""
    pose = art.get("pose")
    path = os.path.join(PROJECT_DIR, art.get("image", ""))
    if not pose or not os.path.isfile(path):
        print("[map] 그림을 건너뜀:", art.get("id"), art.get("image"))
        return
    n = Vector(pose["n"]).normalized()
    up = Vector(pose["up"]).normalized()
    right = up.cross(n).normalized()
    up = n.cross(right).normalized()
    R = Matrix((right, n, up)).transposed()
    T = Matrix.Translation(Vector(pose["c"])) @ R.to_4x4()
    w = float(art["width"]) * UNIT
    h = w * float(art["aspect"])
    fw, fd, fmat = ART_FRAMES.get(art.get("frame", "canvas"), ART_FRAMES["canvas"])
    aid = art["id"]
    body_mat = M["art_canvas"] if fmat is None else M["art_back"]
    oriented_box(B, f"Art_{aid}_Body", T @ Vector((0, ART_DEPTH / 2, 0)), (w, ART_DEPTH, h), body_mat, R,
                 bevel=mm(2))
    if fmat:
        for k, (cx, cz, sx, sz) in enumerate(((0, h / 2 + fw / 2, w + 2 * fw, fw), (0, -h / 2 - fw / 2, w + 2 * fw, fw),
                                             (-w / 2 - fw / 2, 0, fw, h), (w / 2 + fw / 2, 0, fw, h))):
            oriented_box(B, f"Art_{aid}_Frame{k}", T @ Vector((cx, fd / 2, cz)), (sx, fd, sz), M[fmat], R,
                         bevel=mm(2))
    bm = bmesh.new()
    y = ART_DEPTH + mm(1)
    vs = [bm.verts.new(T @ Vector((x, y, z))) for x, z in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2),
                                                          (-w / 2, h / 2))]
    f = bm.faces.new(vs)
    uv = bm.loops.layers.uv.new("UVMap")
    for loop, co in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop[uv].uv = co
    o = B.obj(f"Art_{aid}_Image", bm, mat_image(path), smooth=False)
    o["game_keep"] = 1


def room_mounts(room):
    """방 벽 중 그림을 걸 수 있는 면 (장면 좌표)"""
    W, H = ROOM_W, ROOM_H
    back = mount_spec("back", "정면 벽", (0, BACK_Y, 0), (0, -1, 0), W, H, default_size=1.0)
    if room == "gallery":
        return [mount_spec("left", "왼쪽 벽", (-W / 2, 0, 0), (1, 0, 0), ROOM_D, H, default_size=1.0),
                mount_spec("right", "오른쪽 벽", (W / 2, 0, 0), (-1, 0, 0), ROOM_D, H, default_size=1.0),
                back]
    return [back]


def gallery_default_layout():
    items = []

    def add(iid, typ, x, y, rot=0.0):
        items.append(dict(id=iid, type=typ, x=round(x, 4), y=round(y, 4), rot=round(rot, 2)))

    add("partition_36_1", "partition_36", -1.6, 2.4)
    add("partition_24_1", "partition_24", -4.2, -2.6, 90)
    add("bench_1", "gallery_bench", -1.2, -1.6)
    add("plinth_1", "plinth", 4.6, 2.8)
    add("easel_pro_1", "easel_pro", 5.2, -1.2, -20)
    return dict(version=1, unit_per_m=UNIT, room="gallery",
                doll_spot=dict(x=round(DEFAULT_DOLL_SPOT[0], 4), y=round(DEFAULT_DOLL_SPOT[1], 4)),
                items=items, arts=[])


def default_layout(room="classroom"):
    if room == "gallery":
        return gallery_default_layout()
    return classroom_default_layout()


def classroom_default_layout():
    """지금까지 만든 방과 똑같은 기본 배치"""
    xw, pf, pb, y_front = _left_wall_refs()
    right_x0, left_x0, lcx, (hx0, hx1, hy0, hy1) = _sink_refs()
    items = []

    def add(iid, typ, x, y, rot=0.0):
        items.append(dict(id=iid, type=typ, x=round(x, 4), y=round(y, 4), rot=round(rot, 2)))

    add("cabinet_left", "cabinet_left", xw + CAB_D / 2, (y_front + pf) / 2)
    add("cabinet_right", "cabinet_right", xw + CAB_D / 2, pb + RCAB_LEN / 2)
    add("sink", "sink_cabinet", lcx, BACK_Y - BASE_D / 2)
    add("drying", "drying_cabinet", right_x0 + BASE_W / 2, BACK_Y - BASE_D / 2)
    add("stool", "step_stool", (hx0 + hx1) / 2, BACK_Y - BASE_D - mm(STOOL_D / 2) - mm(15))
    add("table", "table", TABLE_X, TABLE_Y, 90)
    # 의자 8개: 책상(긴 쪽이 y인 상태) 기준 위치를 책상 중심으로 90도 돌린 자리
    cx, cy = TABLE_X, TABLE_Y
    turn = (Matrix.Translation((cx, cy, 0)) @ Matrix.Rotation(math.radians(90), 4, "Z")
            @ Matrix.Translation((-cx, -cy, 0)))
    ys = [cy + mm(v) for v in (-900, -320, 320, 900)]
    wall_side = ["junior_chair_red", "windsor_chair", "windsor_chair", "junior_chair_black"]
    room_side = ["junior_chair_black", "windsor_chair", "windsor_chair", "junior_chair_red"]
    jitter = (4, -3, 2, -5, 3, -2, 5, -4)
    n = 0
    for side, (lst, ang) in enumerate(((wall_side, 90), (room_side, -90))):
        sx = -1 if side == 0 else 1
        for i, typ in enumerate(lst):
            depth = mm(280) if typ.startswith("junior") else mm(390)
            x = cx + sx * (TABLE_W / 2 + depth / 2 - mm(40))
            p = turn @ Vector((x, ys[i], 0.0))
            add(f"chair_{n + 1}", typ, p.x, p.y, ang + jitter[n] + 90)
            n += 1
    add("blocks", "toy_blocks", -3.25 * SX, -5.1)
    add("ball", "toy_ball", -1.9 * SX, -5.8)
    add("plant", "plant", 4.9 * SX, 1.6)
    add("cushion", "cushion", 4.6 * SX, -1.4)
    add("rug", "rug", DEFAULT_DOLL_SPOT[0], DEFAULT_DOLL_SPOT[1] + 0.2)
    add("easel", "easel", 6.2, -5.6)
    add("easel_pro", "easel_pro", 1.2, 5.6)
    return dict(version=1, unit_per_m=UNIT, room="classroom",
                doll_spot=dict(x=round(DEFAULT_DOLL_SPOT[0], 4), y=round(DEFAULT_DOLL_SPOT[1], 4)),
                items=items, arts=[])


def layout_path(room):
    return os.path.join(PROJECT_DIR, ROOMS[room]["layout"])


def load_layout(room="classroom"):
    try:
        with open(layout_path(room), encoding="utf-8") as f:
            data = json.load(f)
        data["items"] = [e for e in data.get("items", []) if e.get("type") in ITEM_TYPES]
        data.setdefault("arts", [])
        return data
    except (OSError, ValueError):
        return default_layout(room)


def room_info(room="classroom"):
    """편집기에 넘길 방 정보 (장면 단위)"""
    xw, pf, pb, y_front = _left_wall_refs()
    half = math.atan(36.0 / 2 / TV_LENS)
    dist = (ROOM_W / 2) / math.tan(half)
    obstacles = []
    if room == "classroom":
        xe = ROOM_W / 2
        obstacles = [
            dict(name="가운데 기둥", x0=xw, x1=xw + PIL_D, y0=pf, y1=pb),
            dict(name="왼쪽 앞 기둥", x0=xw, x1=xw + PIL_D, y0=FRONT_Y, y1=FRONT_Y + PIER_W),
            dict(name="왼쪽 뒤 기둥", x0=xw, x1=xw + PIL_D, y0=BACK_Y - PIER_W, y1=BACK_Y),
            dict(name="오른쪽 앞 기둥", x0=xe - PIL_D, x1=xe, y0=FRONT_Y, y1=FRONT_Y + PIER_W),
            dict(name="오른쪽 뒤 기둥", x0=xe - PIL_D, x1=xe, y0=BACK_Y - PIER_W, y1=BACK_Y),
        ]
    return dict(
        id=room, name=ROOMS[room]["name"], shell=ROOMS[room]["shell"], prefix=ROOMS[room]["prefix"],
        unit_per_m=UNIT, width=ROOM_W, height=ROOM_H, depth=ROOM_D, front_y=FRONT_Y, back_y=BACK_Y,
        walls=dict(left=-ROOM_W / 2, right=ROOM_W / 2, back=BACK_Y),
        mounts=[dict(m, origin=_round_vec(m["origin"]), normal=_round_vec(m["normal"]), up=_round_vec(m["up"]))
                for m in room_mounts(room)],
        obstacles=obstacles,
        tv_camera=dict(x=0.0, y=FRONT_Y - dist, z=ROOM_H / 2, hfov_deg=math.degrees(2 * half),
                       res=list(TV_RES)),
    )

WARM = (1.0, 0.97, 0.92)


def room_lights(link, room=None, phase=None):
    """방 조명. phase(시간대, phases.py)에 따라 창빛·천장등 세기가 달라진다.
    오른쪽은 건물 안 상가 복도라 시간과 상관없이 늘 같다."""
    room = room or CURRENT_ROOM
    ph = phases.get(phase or phases.DEFAULT)
    out = []
    # 왼쪽 창으로 드는 자연광이 방의 주광. 천장 매립등은 어두울 때만 세진다
    specs = (("RoomTop", (0, 0.3, ROOM_H - 0.3), 280 * SX * ph["top"], (8 * SX, ROOM_D * 0.7), (0, 0, 0), WARM),
             ("RoomFront", (0, FRONT_Y - 3.0, 3.8), 90 * SX * ph["top"], (8 * SX, 3),
              (math.radians(80), 0, 0), WARM),
             ("CeilingPanels", (0, 0.3, ROOM_H - 0.45), 560 * SX * ph["panel"], (7 * SX, ROOM_D * 0.6),
              (0, 0, 0), (1.0, 0.98, 0.95)),
             ("SunThroughGlass", (-ROOM_W / 2 - 3.0, 0.0, 5.0), ph["sun"], (4.5, ROOM_D),
              (0, math.radians(-65), 0), ph["sun_color"]),
             ("CorridorLight", (ROOM_W / 2 + WALL_T + CORR_W * 0.5, 0.0, ROOM_H - 0.5), 1500,
              (CORR_W * 0.8, ROOM_D * 1.1), (0, 0, 0), (1.0, 0.96, 0.9)))
    if room == "gallery":
        a = math.radians(50)
        specs = (("RoomTop", (0, 0.3, ROOM_H - 0.3), 250 * SX, (8 * SX, ROOM_D * 0.7), (0, 0, 0), WARM),
                 ("RoomFront", (0, FRONT_Y - 3.0, 3.8), 76 * SX, (8 * SX, 3), (math.radians(80), 0, 0), WARM),
                 ("WashLeft", (-ROOM_W / 2 + 2.5, 0.0, ROOM_H - 0.5), 200, (0.6, ROOM_D * 0.8), (0, a, 0), WARM),
                 ("WashRight", (ROOM_W / 2 - 2.5, 0.0, ROOM_H - 0.5), 200, (0.6, ROOM_D * 0.8), (0, -a, 0), WARM),
                 ("WashBack", (0.0, BACK_Y - 2.5, ROOM_H - 0.5), 200, (ROOM_W * 0.8, 0.6), (a, 0, 0), WARM))
    for name, loc, energy, (sx, sy), rot, color in specs:
        ld = bpy.data.lights.new(name, "AREA")
        ld.shape = "RECTANGLE"
        ld.size, ld.size_y = sx, sy
        ld.energy = energy
        ld.color = color
        o = bpy.data.objects.new(name, ld)
        o.location = loc
        o.rotation_euler = rot
        # 창 너머로 조명판이 하얗게 비치지 않게 (유리를 지나오는 빛·반사도 끈다. 밝히는 일은 그대로)
        o.visible_camera = o.visible_transmission = o.visible_glossy = False
        link(o)
        out.append(o)
    return out


def apply_phase(phase=None, room=None):
    """시간대에 맞춰 천장 매립등 밝기를 바꾸고, (하늘빛, 노출) 을 돌려준다.
    전시실은 창이 없어 시간대와 상관없이 늘 같다."""
    room = room or CURRENT_ROOM
    ph = phases.get(phase or phases.DEFAULT)
    if room == "gallery":
        return ROOM_WORLD, GALLERY_EXPOSURE
    m = bpy.data.materials.get("PanelLight")
    if m and m.use_nodes:
        for nd in m.node_tree.nodes:
            if nd.type == "BSDF_PRINCIPLED":
                nd.inputs["Emission Strength"].default_value = 2.0 * ph["panel"]
    return (*ph["sky"], 1.0), ph["exposure"]


def tv_camera(link):
    """방 입구(16:9)가 화면에 딱 맞도록 정면에 둔 카메라"""
    cd = bpy.data.cameras.new("TVCam")
    cd.lens = TV_LENS
    cd.sensor_fit = "HORIZONTAL"
    half = math.atan(cd.sensor_width / 2 / TV_LENS)
    dist = (ROOM_W / 2) / math.tan(half)        # 입구 가로가 화면 가로에 딱 맞는 거리 (세로도 16:9라 딱 맞음)
    cam = bpy.data.objects.new("TVCam", cd)
    cam.location = (0, FRONT_Y - dist, ROOM_H / 2)
    cam.rotation_euler = (math.radians(90), 0, 0)
    link(cam)
    return cam


# ---------- 게임/편집기용 카탈로그 ----------
def export_catalog(exp_dir, op_ctx=None):
    """방 뼈대(room_shell*.glb) + 가구 종류별 glb(catalog/<type>.glb, 기준점이 원점) + catalog.json"""
    from game_export import export_game
    cat_dir = os.path.join(exp_dir, "catalog")
    os.makedirs(cat_dir, exist_ok=True)
    scene = bpy.context.scene
    coll = bpy.data.collections.new("CatalogTmp")
    scene.collection.children.link(coll)
    B = Builder(coll.objects.link)
    M = make_materials()
    types = []
    for tid, t in ITEM_TYPES.items():
        emp, parts = make_item(B, M, coll.objects.link, dict(id=f"cat_{tid}", type=tid, x=0.0, y=0.0, rot=0.0))
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        pts = []
        for o in parts:
            if o.type != "MESH":
                continue
            oe = o.evaluated_get(dg)
            pts += [oe.matrix_world @ Vector(c) for c in oe.bound_box]
        export_game([emp] + parts, os.path.join(cat_dir, f"{tid}.glb"), None, animations=False, op_ctx=op_ctx)
        types.append(dict(
            id=tid, name=t["name"], category=t["category"], back=t["back"], file=f"catalog/{tid}.glb",
            mounts=type_mounts(tid),
            bbox=dict(x0=min(p.x for p in pts), x1=max(p.x for p in pts), y0=min(p.y for p in pts),
                      y1=max(p.y for p in pts), z0=min(p.z for p in pts), z1=max(p.z for p in pts))))
        for o in parts + [emp]:
            bpy.data.objects.remove(o)
    # 방 뼈대 (방마다)
    for rid, r in ROOMS.items():
        SB = Builder(coll.objects.link)
        build_shell(SB, M, rid)
        export_game(list(SB.objs), os.path.join(exp_dir, r["shell"]), None, animations=False, op_ctx=op_ctx)
        for o in SB.objs:
            bpy.data.objects.remove(o)
    bpy.data.collections.remove(coll)
    with open(os.path.join(exp_dir, "catalog.json"), "w", encoding="utf-8") as f:
        json.dump(dict(room=room_info("classroom"), rooms={rid: room_info(rid) for rid in ROOMS}, types=types,
                       default_layout=default_layout("classroom"),
                       default_layouts={rid: default_layout(rid) for rid in ROOMS}),
                  f, ensure_ascii=False, indent=1)
    print(f"[map] catalog: {len(types)} types")


# ---------- 단독 실행 ----------
def _main():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from game_export import export_game
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = argv[0] if argv else os.path.join(here, "renders")
    exp_dir = os.path.join(os.path.dirname(os.path.abspath(out_dir)), "export")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(exp_dir, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    coll = bpy.data.collections.new("Map")
    scene.collection.children.link(coll)
    objs = build_room(coll.objects.link)
    room_lights(coll.objects.link)
    scene.camera = tv_camera(scene.collection.objects.link)
    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = ROOM_WORLD

    scene.render.engine = "CYCLES"
    scene.cycles.samples = int(os.environ.get("MAP_SAMPLES", "96"))
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "AgX"
    scene.render.resolution_x, scene.render.resolution_y = TV_RES
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "OPTIX"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == "OPTIX"
        scene.cycles.device = "GPU"
    except Exception as ex:
        print("[map] GPU 설정 실패:", ex)
    if os.environ.get("MAP_BUILD_ONLY") == "1":      # 설계 확인용: 렌더/내보내기 없이 .blend만 저장
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(here, ROOMS[CURRENT_ROOM]["blend"]))
        print("[map] build only")
        return
    if os.environ.get("MAP_SKIP_RENDER") != "1":
        scene.render.filepath = os.path.join(out_dir, os.environ.get("MAP_RENDER_NAME", f"{ROOM_PREFIX}_tv.png"))
        pct = int(os.environ.get("MAP_RES_PCT", "100"))
        scene.render.resolution_percentage = pct
        bpy.ops.render.render(write_still=True)
        print("[map] saved", scene.render.filepath)

    n, tris = export_game(objs, os.path.join(exp_dir, f"{ROOM_EXPORT}.glb"),
                          os.path.join(exp_dir, f"{ROOM_EXPORT}.fbx"), animations=False)
    print(f"[map] {CURRENT_ROOM}: exported {n} meshes, ~{tris} tris")
    export_catalog(exp_dir)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(here, ROOMS[CURRENT_ROOM]["blend"]))


# 배치 파일 읽기 (doll.py 도 import 시 이 값을 사용)
LAYOUT = load_layout(CURRENT_ROOM)
DOLL_SPOT = (LAYOUT.get("doll_spot", {}).get("x", DEFAULT_DOLL_SPOT[0]),
             LAYOUT.get("doll_spot", {}).get("y", DEFAULT_DOLL_SPOT[1]))

if __name__ == "__main__":
    _main()
