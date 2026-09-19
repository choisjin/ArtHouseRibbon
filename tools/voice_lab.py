"""Supertonic 목소리 실험실: 섞기 · 음색/말투 따로 · 과장 · 아이 목소리 변환(WORLD) 샘플 만들기

같은 문장을 여러 방법으로 합성해 wav 로 저장하고, 브라우저로 한 번에 들어 볼 index.html 을 만든다.

설치:
  source server/.venv/bin/activate   (supertonic 이 있는 환경)
  pip install pyworld                 # 아이 목소리 변환용. 없으면 그 샘플만 건너뛴다

사용법:
  python tools/voice_lab.py
  python tools/voice_lab.py --text "우와, 정말 멋지다! 이건 뭘 그린 거야?"
  open voice_lab_out/index.html       (맥에서 브라우저로 열기)

만드는 것 (파일 이름 = 방법):
  base_F1 ...          기본 목소리 10개 (비교 기준)
  mix_F1_F3_30 ...     F1 70% + F3 30% 처럼 두 목소리 섞기
  ttl_F1_dp_M1 ...     F1 의 음색 + M1 의 말투(리듬)
  exag_F1_vs_M1_x1.5   F1 을 M1 반대쪽으로 과장
  pitch_F1_+3          지금 쓰는 librosa 피치 (울림까지 같이 올라감, 비교용)
  child_F1_p1.15_f1.10 WORLD 로 음높이 x1.15, 울림(포먼트) x1.10 -> 어려 보이는 목소리
"""
import argparse
import html
import os
import sys
import time

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

from ribbon.providers.tts import pitch_shift, world_child  # noqa: E402  서버가 쓰는 변환 그대로


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--text", default="안녕! 나는 리본이야. 오늘은 뭘 그려 볼까? 우와, 정말 멋지다!")
    ap.add_argument("--out", default=os.path.join(ROOT, "voice_lab_out"))
    ap.add_argument("--speed", type=float, default=1.05)
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--seed", type=int, default=7, help="같은 시드면 매번 같은 소리 (비교가 공정하도록)")
    ap.add_argument("--set", default="basic", choices=["basic", "kids", "younger"],
                    help="basic: 방법별 1차 / kids: 여자·남자아이 2차 / younger: 고른 아이 목소리를 더 어리게 3차")
    args = ap.parse_args()
    if args.set != "basic" and args.out == os.path.join(ROOT, "voice_lab_out"):
        args.out = os.path.join(ROOT, "voice_lab_out", args.set)
    os.makedirs(args.out, exist_ok=True)

    from supertonic import TTS
    from supertonic.core import Style

    tts = TTS(auto_download=True)
    sr = int(getattr(tts, "sample_rate", 44100))
    names = sorted(tts.voice_style_names)
    S = {v: tts.get_voice_style(voice_name=v) for v in names}

    def mix(a, b, r):
        return Style(((1 - r) * S[a].ttl + r * S[b].ttl).astype(np.float32),
                     ((1 - r) * S[a].dp + r * S[b].dp).astype(np.float32))

    def mixed(ttl, dp=None):
        """ttl/dp 를 {목소리: 비율} 로. dp 를 안 주면 ttl 과 같은 비율"""
        dp = dp or ttl
        return Style(sum(r * S[v].ttl for v, r in ttl.items()).astype(np.float32),
                     sum(r * S[v].dp for v, r in dp.items()).astype(np.float32))

    try:
        import pyworld  # noqa: F401
        has_world = True
    except ImportError as e:
        has_world = False
        print(f"pyworld 를 불러오지 못해 아이 목소리 변환은 건너뜁니다: {e!r}")

    samples = []  # (파일 이름, 설명, Style, 후처리)
    if args.set != "basic":
        if not has_world:
            sys.exit(f"--set {args.set} 는 아이 변환(pyworld)이 필요합니다")
        samples = kids_samples(mixed) if args.set == "kids" else younger_samples(mixed)
    else:
        samples = basic_samples(S, names, mix, has_world)

    run(args, tts, sr, samples)


def kids_samples(mixed):
    """2차: 여자아이 G, 남자아이 B. 1차에서 고른 5개(P)를 기준으로 섞기 + 아이 변환을 넓힌다"""
    W = lambda p, f: ("world", p, f)  # noqa: E731
    out = [
        ("P1_ttl_F1_dp_F3", "고른 것: F1 음색 + F3 말투", mixed({"F1": 1}, {"F3": 1}), None),
        ("P2_mix_F1_F3_70", "고른 것: F1 30% + F3 70%", mixed({"F1": .3, "F3": .7}), None),
        ("P3_child_F3", "고른 것: F3 아이 x1.2 / x1.12", mixed({"F3": 1}), W(1.2, 1.12)),
        ("P4_child_M1", "고른 것: M1 아이 x1.3 / x1.15", mixed({"M1": 1}), W(1.3, 1.15)),
        ("P5_child_M1", "고른 것: M1 아이 x1.5 / x1.2", mixed({"M1": 1}), W(1.5, 1.2)),
    ]
    g = []  # 여자아이
    for v in ["F1", "F2", "F3", "F4", "F5"]:
        g.append((f"{v} 아이", mixed({v: 1}), W(1.2, 1.12)))
    for a, b in [("F1", "F3"), ("F2", "F3"), ("F3", "F5"), ("F3", "F4"), ("F1", "F2"), ("F2", "F5")]:
        g.append((f"{a}+{b} 반반 아이", mixed({a: .5, b: .5}), W(1.2, 1.12)))
    for a, b in [("F1", "F3"), ("F3", "F1"), ("F2", "F3")]:
        g.append((f"{a} 음색 + {b} 말투 아이", mixed({a: 1}, {b: 1}), W(1.2, 1.12)))
    g.append(("F1 30% + F3 70% 아이", mixed({"F1": .3, "F3": .7}), W(1.2, 1.12)))
    for p, f in [(1.1, 1.08), (1.3, 1.15), (1.2, 1.18)]:
        g.append((f"F3 아이 x{p} / x{f}", mixed({"F3": 1}), W(p, f)))
    b_ = []  # 남자아이
    for v in ["M1", "M2", "M3", "M4", "M5"]:
        b_.append((f"{v} 아이", mixed({v: 1}), W(1.35, 1.17)))
    for a, b in [("M1", "M2"), ("M1", "M3"), ("M2", "M4"), ("M3", "M5"), ("M1", "M4")]:
        b_.append((f"{a}+{b} 반반 아이", mixed({a: .5, b: .5}), W(1.35, 1.17)))
    b_.append(("M1 70% + F3 30% 아이 (어린 남자아이)", mixed({"M1": .7, "F3": .3}), W(1.25, 1.12)))
    b_.append(("M2 70% + F1 30% 아이 (어린 남자아이)", mixed({"M2": .7, "F1": .3}), W(1.25, 1.12)))
    b_.append(("M1 음색 + F3 말투 아이", mixed({"M1": 1}, {"F3": 1}), W(1.35, 1.17)))
    b_.append(("M1 음색 + M3 말투 아이", mixed({"M1": 1}, {"M3": 1}), W(1.35, 1.17)))
    for p, f in [(1.4, 1.18), (1.6, 1.22)]:
        b_.append((f"M1 아이 x{p} / x{f}", mixed({"M1": 1}), W(p, f)))
    for i, (desc, st, post) in enumerate(g, 1):
        out.append((f"G{i:02d}", f"여자아이: {desc}", st, post))
    for i, (desc, st, post) in enumerate(b_, 1):
        out.append((f"B{i:02d}", f"남자아이: {desc}", st, post))
    return out


def younger_samples(mixed):
    """3차: 2차에서 고른 4개를 더 어리게. 음높이·울림을 단계적으로 올리고, 어린아이답게 조금 느린 것도"""
    W = lambda p, f: ("world", p, f)  # noqa: E731
    picks = [  # (이름, 2차 설명, Style, 2차 세기)
        ("G12", "F1 음색 + F3 말투", mixed({"F1": 1}, {"F3": 1}), (1.2, 1.12)),
        ("G14", "F2 음색 + F3 말투", mixed({"F2": 1}, {"F3": 1}), (1.2, 1.12)),
        ("G15", "F1 30% + F3 70%", mixed({"F1": .3, "F3": .7}), (1.2, 1.12)),
        ("B11", "M1 70% + F3 30%", mixed({"M1": .7, "F3": .3}), (1.25, 1.12)),
    ]
    out = []
    for name, desc, st, (p0, f0) in picks:
        out.append((f"Y{name}-0", f"{desc} (2차에서 고른 것 x{p0} / x{f0})", st, W(p0, f0)))
        for i, (dp, df) in enumerate([(0.1, 0.05), (0.2, 0.09), (0.3, 0.13), (0.4, 0.17)], 1):
            p, f = round(p0 + dp, 2), round(f0 + df, 2)
            out.append((f"Y{name}-{i}", f"{desc} 더 어리게 {i}단계: x{p} / x{f}", st, W(p, f)))
        p, f = round(p0 + 0.2, 2), round(f0 + 0.09, 2)
        out.append((f"Y{name}-s", f"{desc} 2단계 + 조금 느리게(0.95): x{p} / x{f}", st, W(p, f), 0.95))
    # 남자아이는 여자 목소리를 더 섞으면 변성 전 어린 남자아이에 가까워진다
    for r in (0.4, 0.5):
        out.append((f"YB11-m{int(r * 100)}", f"M1 {int((1 - r) * 100)}% + F3 {int(r * 100)}% x1.35 / x1.17",
                    mixed({"M1": 1 - r, "F3": r}), W(1.35, 1.17)))
    return out


def basic_samples(S, names, mix, has_world):
    from supertonic.core import Style

    samples = []
    for v in names:
        samples.append((f"base_{v}", f"기본 {v}", S[v], None))
    for a, b in [("F1", "F3"), ("F1", "F5"), ("F2", "F4"), ("M1", "M3")]:
        for r in (0.3, 0.5, 0.7):
            samples.append((f"mix_{a}_{b}_{int(r * 100)}", f"{a} {int((1 - r) * 100)}% + {b} {int(r * 100)}%",
                            mix(a, b, r), None))
    samples.append(("mix_F1_M1_50", "F1 50% + M1 50% (중성적)", mix("F1", "M1", 0.5), None))
    for a, b in [("F1", "M1"), ("F1", "F3"), ("M1", "F1")]:
        samples.append((f"ttl_{a}_dp_{b}", f"{a} 음색 + {b} 말투", Style(S[a].ttl, S[b].dp), None))
    for a, b, k in [("F1", "M1", 1.3), ("F1", "M1", 1.6), ("F3", "F1", 1.5)]:
        st = Style((k * S[a].ttl + (1 - k) * S[b].ttl).astype(np.float32), S[a].dp)
        samples.append((f"exag_{a}_vs_{b}_x{k}", f"{a} 를 {b} 반대쪽으로 {k}배 과장", st, None))
    for v, semi in [("F1", 3), ("F1", 6)]:
        samples.append((f"pitch_{v}_+{semi}", f"{v} + 지금 방식 피치 +{semi} (비교용)", S[v],
                        ("pitch", semi)))
    if has_world:
        for v, p, f in [("F1", 1.15, 1.08), ("F1", 1.2, 1.12), ("F1", 1.3, 1.18), ("F3", 1.2, 1.12),
                        ("M1", 1.3, 1.15), ("M1", 1.5, 1.2), ("F1", 1.0, 1.12)]:
            samples.append((f"child_{v}_p{p}_f{f}", f"{v} 아이 변환: 음높이 x{p}, 울림 x{f}", S[v],
                            ("world", p, f)))
    return samples


def run(args, tts, sr, samples):
    rows = []
    for fname, desc, style, post, *rest in samples:
        np.random.seed(args.seed)  # 합성 잡음을 같게 맞춰 방법 차이만 들리게
        t0 = time.perf_counter()
        wav, _ = tts.synthesize(text=args.text, voice_style=style, total_steps=args.steps, speed=rest[0] if rest else args.speed,
                                lang="ko", verbose=False)
        synth_s = time.perf_counter() - t0
        post_s = 0.0
        if post:
            t1 = time.perf_counter()
            if post[0] == "pitch":
                wav = pitch_shift(np.asarray(wav), sr, post[1])
            else:
                wav = world_child(wav, sr, post[1], post[2])[None, :]
            post_s = time.perf_counter() - t1
        tts.save_audio(np.asarray(wav, dtype=np.float32).reshape(1, -1), os.path.join(args.out, fname + ".wav"))
        rows.append((fname, desc, synth_s, post_s))
        extra = f" + 후처리 {post_s:.2f}s" if post else ""
        print(f"{fname:<24} {synth_s:.2f}s{extra}  {desc}", flush=True)

    with open(os.path.join(args.out, "index.html"), "w", encoding="utf-8") as f:
        f.write("<!doctype html><meta charset=utf-8><title>목소리 실험실</title>"
                "<style>body{font-family:sans-serif;margin:16px}td{padding:4px 8px}"
                "tr:nth-child(even){background:#f3f3f3}</style>")
        f.write(f"<h2>목소리 실험실</h2><p>{html.escape(args.text)}</p><table>")
        group = None
        for fname, desc, synth_s, post_s in rows:
            g = fname.split("_")[0]
            if g[:1] in "PGB" and g[1:2].isdigit():   # kids: P 고른 것 / G 여자아이 / B 남자아이
                g = {"P": "고른 것", "G": "여자아이", "B": "남자아이"}[g[0]]
            elif g[:1] == "Y":                         # younger: YG12-2 -> G12 더 어리게
                g = g[1:].split("-")[0] + " 더 어리게"
            if g != group:
                f.write(f"<tr><th colspan=4 align=left style='padding-top:16px'>{g}</th></tr>")
                group = g
            f.write(f"<tr><td>{html.escape(desc)}</td><td><audio controls preload=none src='{fname}.wav'></audio></td>"
                    f"<td>{fname}</td><td>{synth_s:.2f}s{f' + {post_s:.2f}s' if post_s else ''}</td></tr>")
        f.write("</table>")
    print(f"\n{len(rows)}개 만듦. 브라우저로 열기: {os.path.join(args.out, 'index.html')}")


if __name__ == "__main__":
    main()
