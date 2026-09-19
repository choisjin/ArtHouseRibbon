"""포켓몬 생김새 설명 만들기: 공식 그림을 그림 보는 대화 모델(맥미니 mlx-serve, gemma 등)에게 보여 주고
아이가 알아듣는 생김새 설명 4문장을 받는다 -> server/ribbon/knowledge/pokemon_looks.json

"설명 듣고 맞추기" 가 첫 문제와 힌트에 쓴다 (도감에는 생김새가 없고, 모델 기억만으로 설명하면 틀린다).
이름은 문장에 넣지 않는다. 이미 만든 것은 건너뛰니 끊겨도 다시 돌리면 이어서 한다.

    python tools/make_pokemon_looks.py                       # 1~151번
    python tools/make_pokemon_looks.py --max-id 251 --base http://192.168.123.101:11234/v1
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

from ribbon.knowledge.pokedex import LOOK_PROMPT, clean_look  # noqa: E402  게임 중 즉석으로 만들 때와 같은 질문

OUT = os.path.join(ROOT, "server", "ribbon", "knowledge", "pokemon_looks.json")
DEX = os.path.join(ROOT, "data", "pokedex.json")
IMG = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/{}.png"


def describe(base, model, name, png):
    body = {"model": model, "max_tokens": 400, "temperature": 0.3, "stream": False,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": LOOK_PROMPT.format(name=name)},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}}]}]}
    req = urllib.request.Request(f"{base}/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    text = json.loads(urllib.request.urlopen(req, timeout=300).read())["choices"][0]["message"]["content"]
    return clean_look(text, name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("MLX_BASE", "http://localhost:11234/v1"))
    ap.add_argument("--model", default="mlx-community/gemma-4-26b-a4b-it-8bit", help="그림을 볼 수 있는 대화 모델")
    ap.add_argument("--max-id", type=int, default=151)
    args = ap.parse_args()

    if not os.path.exists(DEX):
        sys.exit("도감이 없습니다: python tools/fetch_pokedex.py")
    with open(DEX, encoding="utf-8") as f:
        dex = {e["id"]: e for e in json.load(f)["pokemon"]}
    looks = {}
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            looks = json.load(f)
    todo = [i for i in range(1, args.max_id + 1) if i in dex and len(looks.get(str(i), [])) < 2]
    print(f"{len(todo)}마리 만들기 (이미 {len(looks)}마리)", flush=True)
    t0 = time.time()
    for n, pid in enumerate(todo, 1):
        name = dex[pid]["name"]
        try:
            png = urllib.request.urlopen(IMG.format(pid), timeout=30).read()
            lines = describe(args.base, args.model, name, png)
        except Exception as e:  # noqa: BLE001
            print(f"  {pid} {name}: 실패 {e}", flush=True)
            continue
        looks[str(pid)] = lines
        with open(OUT, "w", encoding="utf-8") as f:           # 한 마리마다 저장 (끊겨도 이어서)
            json.dump(dict(sorted(looks.items(), key=lambda kv: int(kv[0]))), f, ensure_ascii=False, indent=1)
        print(f"  [{n}/{len(todo)}] {pid} {name}: {' / '.join(lines)}", flush=True)
    print(f"끝 ({time.time() - t0:.0f}초): {OUT}")


if __name__ == "__main__":
    main()
