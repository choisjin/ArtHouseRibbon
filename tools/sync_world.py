"""Character_Creator(블렌더) 산출물을 리본 프로젝트로 가져온다.

    python tools/sync_world.py [--src E:/Project/Character_Creator] [--doll] [--layouts] [--artworks]

가져오는 것
  - export/room_shell*.glb, catalog/*.glb, catalog.json  → client/public/world/
  - room_map.py, game_export.py, phases.py  → tools/blender/ (맥미니가 TV 배경을 렌더할 때 씀)
  - --doll    : 캐릭터들을 고화질로 다시 내보내기 (블렌더 필요)
                doll.blend → doll.glb (리본이), yoon.blend → ollie.glb (올리), seoyul.blend → seoyul.glb (서율)
  - --layouts : layout.json / layout_gallery.json → data/world/ (이미 있으면 덮어쓰기 전에 history 로 보관)
  - --artworks: artworks/*  → data/artworks/ (index.json 은 합친다)

블렌더에서 가구·인형을 고친 뒤(Character_Creator 의 "블렌더 미리보기") 이 스크립트를 다시 돌리면 된다.
배치 파일 형식은 두 프로젝트가 같아서, 리본 편집기에서 저장한 data/world/*.json 을
Character_Creator 로 복사하면 블렌더 렌더에도 그대로 쓸 수 있다.
"""
import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = os.environ.get("CHARACTER_CREATOR", "E:/Project/Character_Creator")
PUBLIC = os.path.join(ROOT, "client", "public", "world")
DATA = os.path.join(ROOT, "data", "world")
ARTS = os.path.join(ROOT, "data", "artworks")
LAYOUTS = {"layout.json": "classroom.json", "layout_gallery.json": "gallery.json"}


def copy(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    print("  ", os.path.relpath(dst, ROOT))


def sync_models(src):
    exp = os.path.join(src, "export")
    cat = os.path.join(exp, "catalog.json")
    if not os.path.exists(cat):
        raise SystemExit(f"{cat} 가 없습니다. Character_Creator 에서 카탈로그를 먼저 만드세요")
    catalog = json.load(open(cat, encoding="utf-8"))
    files = {r["shell"] for r in catalog["rooms"].values()} | {t["file"] for t in catalog["types"]}
    print("모델:")
    for f in sorted(files):
        copy(os.path.join(exp, f), os.path.join(PUBLIC, f))
    copy(cat, os.path.join(PUBLIC, "catalog.json"))
    print("블렌더 스크립트:")
    for f in ("room_map.py", "game_export.py", "phases.py"):
        copy(os.path.join(src, f), os.path.join(ROOT, "tools", "blender", f))


#: Character_Creator 의 캐릭터 파일 → client/public/world 의 이름 (client/src/world/doll.ts CHARACTERS 와 같게)
DOLLS = {"doll.blend": "doll.glb", "yoon.blend": "ollie.glb", "seoyul.blend": "seoyul.glb"}


def export_doll(src, blender):
    print("캐릭터 (고화질 내보내기):")
    for blend, name in DOLLS.items():
        path = os.path.join(src, blend)
        if not os.path.exists(path):
            print(f"   (건너뜀: {blend} 없음)")
            continue
        out = os.path.join(PUBLIC, name)
        subprocess.run([blender, "-b", path, "--factory-startup",
                        "-P", os.path.join(ROOT, "tools", "blender", "export_doll.py"), "--", out], check=True)
        print("  ", os.path.relpath(out, ROOT))


def sync_layouts(src):
    print("배치:")
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    for s, d in LAYOUTS.items():
        sp = os.path.join(src, s)
        if not os.path.exists(sp):
            continue
        dp = os.path.join(DATA, d)
        if os.path.exists(dp):
            copy(dp, os.path.join(DATA, "history", f"{d[:-5]}_{stamp}.json"))
        copy(sp, dp)


def sync_artworks(src):
    sdir = os.path.join(src, "artworks")
    index = os.path.join(sdir, "index.json")
    if not os.path.exists(index):
        return
    print("그림:")
    items = json.load(open(index, encoding="utf-8"))
    dindex = os.path.join(ARTS, "index.json")
    have = json.load(open(dindex, encoding="utf-8")) if os.path.exists(dindex) else []
    known = {a["file"] for a in have}
    for a in items:
        copy(os.path.join(src, a["file"]), os.path.join(ARTS, os.path.basename(a["file"])))
        if a["file"] not in known:
            have.append(a)
    os.makedirs(ARTS, exist_ok=True)
    with open(dindex, "w", encoding="utf-8") as f:
        json.dump(have, f, ensure_ascii=False, indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--layouts", action="store_true", help="배치 파일도 가져오기")
    ap.add_argument("--artworks", action="store_true", help="올린 그림도 가져오기")
    ap.add_argument("--doll", action="store_true", help="캐릭터들(doll.blend, yoon.blend, seoyul.blend)을 고화질로 다시 내보내기")
    ap.add_argument("--blender", default=os.environ.get("BLENDER_EXE", ""), help="블렌더 실행 파일")
    args = ap.parse_args()
    sync_models(args.src)
    if args.doll:
        sys.path.insert(0, os.path.join(ROOT, "server"))
        from ribbon.world_render import find_blender
        blender = find_blender(args.blender)
        if not blender:
            raise SystemExit("블렌더를 찾지 못했습니다 (--blender 로 지정)")
        export_doll(args.src, blender)
    if args.layouts:
        sync_layouts(args.src)
    if args.artworks:
        sync_artworks(args.src)


if __name__ == "__main__":
    main()
