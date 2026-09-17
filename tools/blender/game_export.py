"""게임 엔진용 내보내기 도우미 (doll.py, room_map.py 공용)

- 절차적 원단 재질은 게임 엔진으로 넘어가지 않으므로, 내보내는 동안만
  기본색/거칠기만 가진 단순 재질로 바꿔 끼운다 (glTF/FBX 모두 색이 유지됨).
- 렌더용 고해상도 메시는 Decimate 모디파이어를 잠시 붙여 폴리곤을 줄인 채로 내보낸다.
- glb: 메시 + 뼈대(뼈에 붙은 부품) + 액션별 애니메이션. fbx: 같은 내용 (Unity/Unreal용).
"""
import bpy


def _plain_material(src):
    name = f"{src.name}_Game"
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        p = m.node_tree.nodes["Principled BSDF"]
        p.inputs["Base Color"].default_value = tuple(src.diffuse_color)
        rough = 0.8
        if src.use_nodes and "Principled BSDF" in src.node_tree.nodes:
            rough = src.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value
            em = src.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value
            if em > 0:
                p.inputs["Emission Color"].default_value = tuple(src.diffuse_color)
                p.inputs["Emission Strength"].default_value = min(em, 3.0)
        p.inputs["Roughness"].default_value = rough
        if src.diffuse_color[3] < 1.0:          # 유리 등 반투명
            p.inputs["Alpha"].default_value = src.diffuse_color[3]
            m.surface_render_method = "BLENDED"
        m.diffuse_color = src.diffuse_color
    return m


def _face_target(n):
    """메시 하나당 목표 면 수"""
    # 작은 소품은 줄이지 않음 (얇은 관/둥근 좌판이 깨지는 것 방지)
    return min(n, max(1500, min(5000, int(n * 0.06))))


def export_game(objs, glb_path, fbx_path=None, animations=True, op_ctx=None, decimate=True,
                fbx_actions=None):
    """objs: 내보낼 오브젝트(뼈대 포함). fbx_actions: (뼈대, [액션...]) → FBX에는 이 액션만 넣음.
    반환: (내보낸 메시 수, 총 삼각형 수 추정)"""
    import contextlib
    ctx = op_ctx or contextlib.nullcontext
    vl = bpy.context.view_layer

    # 선택 정리
    for o in vl.objects:
        o.select_set(False)
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    vl.objects.active = next((o for o in objs if o.type == "ARMATURE"), objs[0])

    swaps, mods, tri_est = [], [], 0
    for o in objs:
        if o.type != "MESH":
            continue
        for slot in o.material_slots:
            if slot.material and not slot.material.get("game_keep"):
                swaps.append((slot, slot.material))
                slot.material = _plain_material(slot.material)
        n = len(o.data.polygons)
        t = _face_target(n) if decimate and not o.get("game_keep") else n
        if t < n:
            mod = o.modifiers.new("GameDecimate", "DECIMATE")
            mod.ratio = t / n
            mods.append((o, mod))
        tri_est += t * 2

    try:
        with ctx():
            bpy.ops.export_scene.gltf(
                filepath=glb_path, export_format="GLB", use_selection=True,
                export_apply=True, export_yup=True, export_materials="EXPORT",
                export_animations=animations, export_animation_mode="ACTIONS",
                export_force_sampling=True, export_skins=False)
            if fbx_path:
                # FBX의 '모든 액션' 옵션은 카메라/이동용 액션까지 뼈대에 적용하므로,
                # 원하는 액션만 잠시 NLA 트랙으로 올려 트랙 단위로 내보낸다.
                tracks, saved = [], None
                rig = None
                if animations and fbx_actions:
                    rig, acts = fbx_actions
                    ad = rig.animation_data_create()
                    saved = ad.action
                    ad.action = None
                    for act in acts:
                        tr = ad.nla_tracks.new()
                        tr.name = act.name
                        st = tr.strips.new(act.name, int(act.frame_range[0]), act)
                        try:
                            if st.action_slot is None and len(act.slots):
                                st.action_slot = act.slots[0]
                        except AttributeError:
                            pass
                        tracks.append(tr)
                try:
                    bpy.ops.export_scene.fbx(
                        filepath=fbx_path, use_selection=True, object_types={"ARMATURE", "MESH", "EMPTY"},
                        use_mesh_modifiers=True, add_leaf_bones=False, apply_scale_options="FBX_SCALE_ALL",
                        bake_anim=bool(animations and fbx_actions), bake_anim_use_all_actions=False,
                        bake_anim_use_nla_strips=True, bake_anim_force_startend_keying=True)
                finally:
                    if rig is not None:
                        for tr in tracks:
                            rig.animation_data.nla_tracks.remove(tr)
                        rig.animation_data.action = saved
    finally:
        for o, mod in mods:
            o.modifiers.remove(mod)
        for slot, mat in swaps:
            slot.material = mat
        for o in objs:
            o.select_set(False)
    return sum(1 for o in objs if o.type == "MESH"), tri_est
