"""포켓몬 맞추기 게임 고르기 화면의 썸네일 3장을 맥미니 MLX 로 만든다 -> data/game_thumbs/{describe,image,peek}.png

서버가 /api/game/thumb/<게임> 으로 바로 보여 준다 (다시 만들면 TV 를 새로 열 때 바뀐다).
집에서 아이와만 쓰는 것이라 실제 포켓몬(피카츄·이브이·팬텀)을 그린다. 글자는 넣지 않는다 (한글 제목은 TV 가 얹는다).
만들기 전에는 서버가 포켓몬 공식 그림으로 대신 보여 준다.

두 가지 방법 중 되는 것으로 (--backend auto):
  serve : 맥미니 mlx-serve (포트 11234) 에 그림 모델이 있으면 OpenAI 방식 /v1/images/generations
  mflux : MLX 로 돌리는 FLUX (pip install mflux). 처음 한 번 모델을 내려받는다 (수 GB)

    python tools/make_game_thumbs.py                    # 셋 다
    python tools/make_game_thumbs.py --only peek --seed 7
    python tools/make_game_thumbs.py --backend mflux --steps 4
    python tools/make_game_thumbs.py --list             # mlx-serve 에 있는 모델 보기
"""
import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "game_thumbs")
STYLE = ("Pokemon official anime art style, bright children's video game title card, bold outlines, "
         "vivid colors, sparkles, centered composition, soft gradient background, "
         "no text, no letters, no words, no logo")
PROMPTS = {
    "describe": "Pikachu happily talking, a large speech bubble with a big question mark next to Pikachu, "
                "a mysterious Pokemon silhouette in the background, " + STYLE,
    "image": "Eevee inside a golden picture frame, Pikachu holding a big magnifying glass looking at it, "
             "stars around, " + STYLE,
    "peek": "a grid of purple square puzzle tiles, some tiles flipped open revealing parts of Gengar hiding "
            "behind them, question marks floating, Who's that Pokemon style, " + STYLE,
}


def http(method, url, body=None, timeout=600):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def serve_models(base):
    return http("GET", f"{base}/models", timeout=10).get("data", [])


def pick_image_model(base, want=""):
    models = serve_models(base)
    if want:
        return want
    for m in models:
        caps = [str(c).lower() for c in (m.get("capabilities") or [])]
        if any("image" in c or "diffusion" in c for c in caps) or "flux" in m["id"].lower() \
                or "diffusion" in m["id"].lower():
            return m["id"]
    return ""


def gen_serve(base, model, prompt, path, size, seed):
    try:
        http("POST", f"{base.rsplit('/v1', 1)[0]}/v1/load-model", {"model": model}, timeout=600)
    except Exception:  # noqa: BLE001 - 올리기 API 가 없어도 만들기는 해 본다
        pass
    body = {"model": model, "prompt": prompt, "n": 1, "size": f"{size}x{size}", "response_format": "b64_json"}
    if seed is not None:
        body["seed"] = seed
    res = http("POST", f"{base}/images/generations", body)
    item = (res.get("data") or [{}])[0]
    if item.get("b64_json"):
        raw = base64.b64decode(item["b64_json"])
    elif item.get("url"):
        with urllib.request.urlopen(item["url"], timeout=120) as r:
            raw = r.read()
    else:
        raise RuntimeError(f"그림이 안 왔습니다: {json.dumps(res)[:300]}")
    with open(path, "wb") as f:
        f.write(raw)


def gen_mflux(prompt, path, size, seed, steps, model):
    exe = shutil.which("mflux-generate")
    if not exe:
        raise RuntimeError("mflux 가 없습니다: pip install mflux")
    cmd = [exe, "--model", model, "--prompt", prompt, "--steps", str(steps), "--width", str(size),
           "--height", str(size), "--output", path, "-q", "8"]
    if seed is not None:
        cmd += ["--seed", str(seed)]
    print("  ", " ".join(cmd[:3]), "...", flush=True)
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend", choices=["auto", "serve", "mflux"], default="auto")
    ap.add_argument("--base", default="http://localhost:11234/v1", help="mlx-serve 주소")
    ap.add_argument("--model", default="", help="mlx-serve 그림 모델 이름 (비우면 찾아본다)")
    ap.add_argument("--mflux-model", default="schnell", help="mflux 모델: schnell (빠름) | dev")
    ap.add_argument("--only", choices=list(PROMPTS), help="하나만 다시 만들기")
    ap.add_argument("--size", type=int, default=768)
    ap.add_argument("--steps", type=int, default=4, help="mflux 단계 수 (schnell 은 2~4)")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--list", action="store_true", help="mlx-serve 모델 목록만 보기")
    args = ap.parse_args()

    if args.list:
        for m in serve_models(args.base):
            print(f"  {m['id']}  capabilities={m.get('capabilities')}")
        return

    backend, model = args.backend, args.model
    if backend in ("auto", "serve"):
        try:
            model = pick_image_model(args.base, model)
        except Exception as e:  # noqa: BLE001
            print(f"mlx-serve 에 연결 못 함 ({e})")
            model = ""
        if model:
            backend = "serve"
            print(f"mlx-serve 그림 모델: {model}")
        elif backend == "serve":
            sys.exit("mlx-serve 에서 그림 모델을 못 찾았습니다. --list 로 보고 --model 로 지정하세요")
        else:
            backend = "mflux"
            print("mlx-serve 에 그림 모델이 없어 mflux 로 만듭니다")

    os.makedirs(OUT, exist_ok=True)
    for mode, prompt in PROMPTS.items():
        if args.only and mode != args.only:
            continue
        path = os.path.join(OUT, f"{mode}.png")
        print(f"[{mode}] 만드는 중...", flush=True)
        if backend == "serve":
            gen_serve(args.base, model, prompt, path, args.size, args.seed)
        else:
            gen_mflux(prompt, path, args.size, args.seed, args.steps, args.mflux_model)
        print(f"  -> {path}")
    print("끝. TV 를 새로 열면 게임 고르기 화면에 나옵니다.")


if __name__ == "__main__":
    main()
