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

from ribbon.providers.tts import pitch_shift  # noqa: E402  지금 서버가 쓰는 피치 변환 그대로


def world_child(wav, sr, pitch=1.15, formant=1.10):
    """WORLD 로 음높이와 울림(스펙트럼 포락선)을 따로 올린다. 울림을 올리면 성도가 짧은 = 어린 목소리처럼 들린다"""
    import pyworld as pw
    x = np.asarray(wav, dtype=np.float64).reshape(-1)
    f0, t = pw.dio(x, sr, frame_period=5.0)
    f0 = pw.stonemask(x, f0, t, sr)
    sp = pw.cheaptrick(x, f0, t, sr)
    ap = pw.d4c(x, f0, t, sr)
    n = sp.shape[1]
    src = np.arange(n) / formant               # 새 주파수 k 는 원래 k/formant 자리의 값
    lo = np.clip(np.floor(src).astype(int), 0, n - 1)
    hi = np.clip(lo + 1, 0, n - 1)
    w = src - np.floor(src)
    sp2 = sp[:, lo] * (1 - w) + sp[:, hi] * w
    ap2 = ap[:, lo] * (1 - w) + ap[:, hi] * w
    y = pw.synthesize(f0 * pitch, np.ascontiguousarray(sp2), np.ascontiguousarray(ap2), sr, 5.0)
    peak = np.abs(y).max()
    if peak > 0.99:
        y = y / peak * 0.99
    return y.astype(np.float32)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--text", default="안녕! 나는 리본이야. 오늘은 뭘 그려 볼까? 우와, 정말 멋지다!")
    ap.add_argument("--out", default=os.path.join(ROOT, "voice_lab_out"))
    ap.add_argument("--speed", type=float, default=1.05)
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--seed", type=int, default=7, help="같은 시드면 매번 같은 소리 (비교가 공정하도록)")
    args = ap.parse_args()
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

    samples = []  # (파일 이름, 설명, Style, 후처리)
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
    try:
        import pyworld  # noqa: F401
        has_world = True
    except ImportError:
        has_world = False
        print("pyworld 가 없어 아이 목소리 변환은 건너뜁니다 (pip install pyworld)")
    if has_world:
        for v, p, f in [("F1", 1.15, 1.08), ("F1", 1.2, 1.12), ("F1", 1.3, 1.18), ("F3", 1.2, 1.12),
                        ("M1", 1.3, 1.15), ("M1", 1.5, 1.2), ("F1", 1.0, 1.12)]:
            samples.append((f"child_{v}_p{p}_f{f}", f"{v} 아이 변환: 음높이 x{p}, 울림 x{f}", S[v],
                            ("world", p, f)))

    rows = []
    for fname, desc, style, post in samples:
        np.random.seed(args.seed)  # 합성 잡음을 같게 맞춰 방법 차이만 들리게
        t0 = time.perf_counter()
        wav, _ = tts.synthesize(text=args.text, voice_style=style, total_steps=args.steps, speed=args.speed,
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
            if g != group:
                f.write(f"<tr><th colspan=4 align=left style='padding-top:16px'>{g}</th></tr>")
                group = g
            f.write(f"<tr><td>{html.escape(desc)}</td><td><audio controls preload=none src='{fname}.wav'></audio></td>"
                    f"<td>{fname}</td><td>{synth_s:.2f}s{f' + {post_s:.2f}s' if post_s else ''}</td></tr>")
        f.write("</table>")
    print(f"\n{len(rows)}개 만듦. 브라우저로 열기: {os.path.join(args.out, 'index.html')}")


if __name__ == "__main__":
    main()
