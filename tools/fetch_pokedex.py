"""포켓몬 도감 받기: PokeAPI(무료 공개 데이터)에서 한국어 도감을 받아 data/pokedex.json 으로 저장한다.

리본이가 아이 말에 포켓몬 이름이 나오면 이 도감을 참고해 틀리지 않게 답한다 (server/ribbon/knowledge/pokedex.py).
인터넷이 되는 곳에서 한 번만 돌리면 된다 (맥미니에서). 받은 원본은 data/.pokeapi_cache/ 에 남겨서
중간에 끊겨도 다시 돌리면 이어서 받는다. 약 2700번 요청, 몇 분 걸린다.

    python tools/fetch_pokedex.py            # 전부 (1000여 마리)
    python tools/fetch_pokedex.py --limit 30 # 시험용

도감 설명 문장은 게임 회사의 저작물이라 학원 안에서만 쓴다 (data/pokedex.json 은 git 에 올리지 않는다).
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://pokeapi.co/api/v2"
CACHE = os.path.join(ROOT, "data", ".pokeapi_cache")
OUT = os.path.join(ROOT, "data", "pokedex.json")


def get(url):
    """캐시가 있으면 캐시, 없으면 받아서 캐시에 저장"""
    key = re.sub(r"[^a-z0-9]+", "_", url.replace(API, "").lower()).strip("_") or "root"
    path = os.path.join(CACHE, key + ".json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ribbon-kids-helper/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            return data
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise RuntimeError(f"{url}: {e}")
            time.sleep(1.5 * (attempt + 1))


def ko(entries, field="name"):
    for e in entries or []:
        if e["language"]["name"] == "ko":
            return e[field]
    return None


def clean(text):
    return re.sub(r"\s+", " ", text.replace("\u000c", " ")).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="앞에서부터 이만큼만 (시험용)")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    os.makedirs(CACHE, exist_ok=True)

    listing = get(f"{API}/pokemon-species?limit=2000")["results"]
    if args.limit:
        listing = listing[:args.limit]
    print(f"포켓몬 {len(listing)}마리 받는 중...", flush=True)
    pool = ThreadPoolExecutor(args.workers)

    species = list(pool.map(lambda s: get(s["url"]), listing))
    print("  종 정보 받음", flush=True)
    pokemon = list(pool.map(lambda sp: get(next(v for v in sp["varieties"] if v["is_default"])["pokemon"]["url"]),
                            species))
    print("  모습·타입 받음", flush=True)

    types = {t["name"]: ko(get(t["url"])["names"]) or t["name"]
             for t in get(f"{API}/type?limit=100")["results"]}
    ko_name = {sp["name"]: ko(sp["names"]) or sp["name"] for sp in species}

    chain_urls = sorted({sp["evolution_chain"]["url"] for sp in species if sp.get("evolution_chain")})
    chains = dict(zip(chain_urls, pool.map(get, chain_urls)))
    print(f"  진화 {len(chains)}갈래 받음", flush=True)

    item_names = {}

    def item_ko(item):
        if item["name"] not in item_names:
            item_names[item["name"]] = ko(get(item["url"])["names"]) or item["name"]
        return item_names[item["name"]]

    def condition(details):
        """진화 조건을 짧은 한국어로"""
        if not details:
            return ""
        # 게임마다 조건이 다르게 여러 개 적혀 있다 (예: 리피아 = 옛날엔 이끼바위 옆, 지금은 리프의돌).
        # 아이가 알아듣기 쉬운 것(진화의 돌 > 레벨 > 나머지)을 고른다
        d = max(details, key=lambda x: (bool(x.get("item")), bool(x.get("min_level"))))
        trig = d["trigger"]["name"]
        parts = []
        if d.get("min_level"):
            parts.append(f"레벨 {d['min_level']}")
        if d.get("item"):
            parts.append(item_ko(d["item"]))
        if trig == "trade":
            parts.append("통신교환" + (f"({item_ko(d['held_item'])} 지니고)" if d.get("held_item") else ""))
        if d.get("min_happiness"):
            parts.append("친해지면")
        if d.get("time_of_day") in ("day", "night"):
            parts.append("낮" if d["time_of_day"] == "day" else "밤")
        if d.get("known_move_type"):
            parts.append(f"{types.get(d['known_move_type']['name'], '')} 기술을 배우고")
        return " ".join(parts) or "특별한 방법"

    def render(node, cond=""):
        name = ko_name.get(node["species"]["name"], node["species"]["name"])
        name = f"{name}({cond})" if cond else name
        kids = [render(c, condition(c["evolution_details"])) for c in node["evolves_to"]]
        if not kids:
            return name
        return name + " → " + (kids[0] if len(kids) == 1 else "[" + " / ".join(kids) + "]")

    evo_text = {url: render(c["chain"]) for url, c in chains.items()}

    dex = []
    for sp, pk in zip(species, pokemon):
        flav, seen = [], set()
        for e in reversed(sp["flavor_text_entries"]):          # 최근 게임부터
            if e["language"]["name"] == "ko":
                t = clean(e["flavor_text"])
                if t not in seen:
                    seen.add(t)
                    flav.append(t)
            if len(flav) >= 2:
                break
        dex.append({
            "id": sp["id"],
            "name": ko_name[sp["name"]],
            "en": sp["name"],
            "genus": ko(sp["genera"], "genus") or "",
            "types": [types.get(t["type"]["name"], t["type"]["name"]) for t in pk["types"]],
            "height_m": pk["height"] / 10,
            "weight_kg": pk["weight"] / 10,
            "legendary": sp.get("is_legendary") or sp.get("is_mythical"),
            "evolution": evo_text.get((sp.get("evolution_chain") or {}).get("url"), ""),
            "flavor": flav,
        })
    dex.sort(key=lambda d: d["id"])
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"source": "PokeAPI (pokeapi.co)", "fetched": time.strftime("%Y-%m-%d"), "pokemon": dex},
                  f, ensure_ascii=False, indent=1)
    no_ko = sum(1 for d in dex if not d["flavor"])
    print(f"저장: {OUT}  ({len(dex)}마리, 한국어 도감 설명 없는 것 {no_ko}마리, {os.path.getsize(OUT) // 1024}KB)")


if __name__ == "__main__":
    sys.exit(main())
