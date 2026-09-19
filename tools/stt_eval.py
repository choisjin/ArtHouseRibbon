"""모아 둔 아이 말 녹음으로 음성 인식 모델을 비교한다 (맥미니에서).

녹음 모으기: 관리자 캐릭터 탭 "아이 말 녹음 저장" 켜기 -> data/recordings/<날짜>/*.wav + index.jsonl
정확도를 재려면 index.jsonl 의 "correct" 에 실제로 한 말을 적어 둔다 (안 적으면 모델끼리 결과만 나란히 본다).

    source server/.venv/bin/activate
    python tools/stt_eval.py                                  # 기본 두 모델, 최근 녹음 30개
    python tools/stt_eval.py --models large-v3-turbo large-v3-mlx --limit 50
    python tools/stt_eval.py --no-prompt                      # 인식 힌트 없이 (힌트 효과 보기)
    python tools/stt_eval.py --no-prepare                     # 소리 다듬기 없이

모델 이름: mlx-community/whisper-<이름> 으로 받는다. 한국어로 따로 학습한 모델은 "/" 가 들어간 HF 저장소 이름을
그대로 쓴다 (MLX 로 바꾼 것이어야 한다). 결과 표: 모델마다 글자 오류율(CER, 낮을수록 좋음)과 한 번에 걸린 시간.
"""
import argparse
import glob
import json
import os
import sys
import time
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

from ribbon.providers.stt import clean_segments, prepare  # noqa: E402  서버와 같은 다듬기·거르기

DEFAULT_MODELS = ["large-v3-turbo", "large-v3-mlx"]   # 지금 쓰는 것 / 더 정확하지만 느린 것


def load(path):
    with wave.open(path, "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16), w.getframerate()


def cer(ref, hyp):
    """글자 오류율 (띄어쓰기·문장부호 빼고)"""
    r = [c for c in ref if c.isalnum()]
    h = [c for c in hyp if c.isalnum()]
    if not r:
        return 0.0 if not h else 1.0
    d = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        prev, d[0] = d[0], i
        for j, hc in enumerate(h, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (rc != hc))
    return d[len(h)] / len(r)


def repo(name):
    if "/" in name:
        return name
    return f"mlx-community/{name}" if name.startswith("whisper-") else f"mlx-community/whisper-{name}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", nargs="+", default=DEFAULT_MODELS)
    ap.add_argument("--dir", default=os.path.join(ROOT, "data", "recordings"))
    ap.add_argument("--limit", type=int, default=30, help="최근 녹음 몇 개")
    ap.add_argument("--no-prompt", action="store_true")
    ap.add_argument("--no-prepare", action="store_true")
    args = ap.parse_args()

    import mlx_whisper

    recs = []
    for idx in sorted(glob.glob(os.path.join(args.dir, "*", "index.jsonl"))):
        with open(idx, encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                r["path"] = os.path.join(os.path.dirname(idx), r["file"])
                if os.path.exists(r["path"]):
                    recs.append(r)
    recs = recs[-args.limit:]
    if not recs:
        sys.exit(f"녹음이 없습니다: {args.dir} (관리자 캐릭터 탭에서 '아이 말 녹음 저장' 을 켜고 대화해 보세요)")
    print(f"녹음 {len(recs)}개, 정답을 적어 둔 것 {sum(1 for r in recs if r.get('correct'))}개\n")

    results = {m: [] for m in args.models}
    times = {m: [] for m in args.models}
    for m in args.models:
        print(f"== {m} ({repo(m)}) 불러오는 중...", flush=True)
        try:
            pcm, sr = load(recs[0]["path"])
            mlx_whisper.transcribe(prepare(pcm, sr), path_or_hf_repo=repo(m), language="ko")   # 첫 호출은 빼고 잰다
        except Exception as e:  # noqa: BLE001
            print(f"   못 씀: {e}")
            results[m] = None
            continue
        for r in recs:
            pcm, sr = load(r["path"])
            audio = pcm.astype(np.float32) / 32768.0 if args.no_prepare else prepare(pcm, sr)
            t0 = time.perf_counter()
            out = mlx_whisper.transcribe(audio, path_or_hf_repo=repo(m), language="ko",
                                         condition_on_previous_text=False,
                                         initial_prompt=None if args.no_prompt else (r.get("prompt") or None))
            times[m].append(time.perf_counter() - t0)
            results[m].append(clean_segments(out.get("segments") or []))

    ok_models = [m for m in args.models if results[m] is not None]
    for i, r in enumerate(recs):
        print(f"\n[{i + 1}] {r['file']} ({r['seconds']}초)" + (f"  정답: {r['correct']}" if r.get("correct") else ""))
        for m in ok_models:
            print(f"   {m:<28} {results[m][i]}")

    print("\n== 요약 (CER 은 정답을 적어 둔 녹음만, 낮을수록 좋음)")
    for m in ok_models:
        scored = [cer(r["correct"], results[m][i]) for i, r in enumerate(recs) if r.get("correct")]
        c = f"{sum(scored) / len(scored):.1%}" if scored else "-"
        print(f"   {m:<28} CER {c:>6}   평균 {sum(times[m]) / len(times[m]):.2f}초")


if __name__ == "__main__":
    main()
