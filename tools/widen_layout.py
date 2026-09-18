"""방을 넓힌 만큼 벽에 붙어 있던 가구를 다시 벽으로 옮긴다 (한 번만 쓰는 스크립트).

    python tools/widen_layout.py [--dry]

네 귀퉁이에 기둥을 세우면서 미술실 가로를 15.6 → 18.2 로 넓혔다 (양쪽 벽이 1.3 씩 바깥으로).
배치 파일(data/world/*.json)은 기기마다 따로라 git 으로 오지 않으므로, 이미 쓰던 배치가 있으면
왼쪽 벽 수납장과 오른쪽 유리벽 쪽 물건이 벽에서 1.3 만큼 떠 보인다. 이 스크립트가 그만큼 옮긴다.
싱크대·건조대는 정면벽 쪽이고 오른쪽 끝이 넓힌 뒤 기둥 왼쪽 면과 딱 맞아서 그대로 둔다.

고치기 전 배치는 data/world/history/ 에 남긴다. 한 번만 돌리면 된다 (두 번 돌리면 벽을 뚫는다).
"""
import argparse
import datetime
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "world")
SHIFT = {"cabinet_left": -1.3, "cabinet_right": -1.3,      # 왼쪽 벽에 붙은 수납장
         "plant": 1.3, "cushion": 1.3, "easel": 1.3}       # 오른쪽 유리벽 쪽 물건


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="바꾸지 않고 보기만")
    args = ap.parse_args()
    path = os.path.join(DATA, "classroom.json")
    if not os.path.exists(path):
        raise SystemExit(f"{path} 가 없습니다")
    with open(path, encoding="utf-8") as f:
        layout = json.load(f)
    moved = []
    for e in layout.get("items", []):
        dx = SHIFT.get(e.get("type"), 0.0)
        if not dx:
            continue
        moved.append((e["type"], round(e["x"], 2), round(e["x"] + dx, 2)))
        e["x"] = round(e["x"] + dx, 4)
    for t, a, b in moved:
        print(f"  {t}: x {a} → {b}")
    if not moved:
        print("옮길 가구가 없습니다")
        return
    if args.dry:
        print("(--dry 라 저장하지 않았습니다)")
        return
    hist = os.path.join(DATA, "history")
    os.makedirs(hist, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    os.replace(path, os.path.join(hist, f"classroom_{stamp}.json"))     # 이전 배치를 history 로
    with open(path, "w", encoding="utf-8") as f:
        json.dump(layout, f, ensure_ascii=False, indent=1)
    print(f"저장했습니다. 이전 배치: data/world/history/classroom_{stamp}.json")
    print("맵 편집기에서 '배경 렌더' 를 한 번 눌러 주세요.")


if __name__ == "__main__":
    main()
