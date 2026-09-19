"""TTS 속도·발음 비교 (맥미니에서 실행)

Supertonic(지금 쓰는 것) / Qwen3-TTS(mlx-audio) / Chatterbox Multilingual 로 같은 문장을 합성해
문장마다 걸린 시간을 재고 wav 로 저장한다. 귀로 들어 보고 숫자를 비교하려는 용도.

설치 (서버 .venv 가 깨지지 않게 따로 만든다):
  python3.12 -m venv ~/tts-bench && source ~/tts-bench/bin/activate
  pip install supertonic httpx numpy                # supertonic
  pip install -U mlx-audio                          # qwen
  pip install chatterbox-tts                        # chatterbox (torch 를 받아서 오래 걸림)

사용법:
  python tools/tts_bench.py                                   # 세 엔진 모두
  python tools/tts_bench.py --engines supertonic,qwen
  python tools/tts_bench.py --with-llm                        # mlx-serve 대화 모델이 옆에서 답하는 중일 때
  python tools/tts_bench.py --engines chatterbox --ref ribbon.wav   # 이 목소리를 흉내 냄 (5~10초 wav)
  python tools/tts_bench.py --qwen-model mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16

결과: tts_bench_out/<엔진>_<목소리>_NN.wav, tts_bench_out/summary.csv, 화면에 표.
엔진마다 따로 프로세스를 띄워 메모리를 돌려받는다 (대화 모델과 메모리를 나눠 쓰니까).

보는 법: "첫 문장" 시간이 대답이 시작되기까지 늦어지는 시간이다. 1초 안쪽이면 자연스럽고 2초 넘으면 굼뜨다.
RTF = 합성 시간 / 소리 길이. 1 보다 작아야 뒤 문장이 앞 문장 재생 중에 준비된다.
"""
import argparse
import csv
import inspect
import json
import os
import subprocess
import sys
import threading
import time
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SENTENCES = [
    "안녕! 나는 리본이야. 오늘은 뭘 그려 볼까?",
    "우와, 하늘을 보라색으로 칠했구나! 정말 멋지다.",
    "크레파스는 꾹꾹 눌러서 칠하면 색이 더 진해져.",
    "선생님이 곧 오실 거야. 조금만 기다려 줄래?",
    "서율이는 오늘 고양이를 그렸대. 너는 무슨 동물을 좋아해?",
    "빨강이랑 노랑을 섞으면 무슨 색이 될까?",
    "물감이 마르려면 십 분쯤 걸려. 그동안 손을 씻고 오자!",
    "오늘 세 번째로 온 친구는 바로 너야.",
    "음, 그건 나도 잘 모르겠어. 선생님께 여쭤보자.",
    "잘 가! 다음 주 토요일에 또 만나.",
]

# Qwen3-TTS VoiceDesign: 설명 한 줄로 목소리를 만든다 (CustomVoice 모델이면 --qwen-voices 에 화자 이름을 넣는다)
QWEN_DESIGNS = {
    "girl": "밝고 명랑한 일곱 살 여자아이 목소리. 또랑또랑하고 말끝이 살짝 올라간다. 표준 한국어.",
    "boy": "장난기 많고 씩씩한 여덟 살 남자아이 목소리. 조금 빠르게 말한다. 표준 한국어.",
    "teacher": "다정하고 차분한 이십 대 여자 선생님 목소리. 아이에게 천천히 또박또박 말한다.",
}


# ---------- 공통 ----------

def save_wav(path, audio, sr):
    a = np.asarray(audio, dtype="float32").reshape(-1)
    a = np.clip(a, -1.0, 1.0)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes((a * 32767).astype("<i2").tobytes())
    return len(a) / float(sr)


def call_with_supported(fn, **kwargs):
    """라이브러리 버전마다 인자 이름이 달라서, 받는 인자만 골라 넘긴다"""
    params = inspect.signature(fn).parameters
    if any(p.kind == p.VAR_KEYWORD for p in params.values()):
        return fn(**kwargs)
    return fn(**{k: v for k, v in kwargs.items() if k in params})


# ---------- 엔진 ----------

class Supertonic:
    name = "supertonic"

    def __init__(self, args):
        from supertonic import TTS
        self.tts = TTS(auto_download=True)
        self.sr = int(getattr(self.tts, "sample_rate", 44100))
        self.voices = args.supertonic_voices.split(",")
        self.styles = {v: self.tts.get_voice_style(voice_name=v) for v in self.voices}

    def synth(self, text, voice):
        wav, _ = self.tts.synthesize(text=text, voice_style=self.styles[voice], total_steps=8, speed=1.05,
                                     lang="ko", verbose=False)
        return wav, self.sr


class Qwen:
    name = "qwen"

    def __init__(self, args):
        from mlx_audio.tts.utils import load_model
        self.model = load_model(args.qwen_model)
        self.sr = int(getattr(self.model, "sample_rate", 24000))
        if args.qwen_voices:
            # CustomVoice 모델의 내장 화자 (예: Sohee)
            self.voices = args.qwen_voices.split(",")
            self.kw = {v: {"voice": v} for v in self.voices}
        else:
            self.voices = list(QWEN_DESIGNS)
            self.kw = {v: {"instruct": QWEN_DESIGNS[v]} for v in self.voices}

    def synth(self, text, voice):
        chunks, sr = [], self.sr
        results = call_with_supported(self.model.generate, text=text, language="Korean", lang_code="ko",
                                      verbose=False, **self.kw[voice])
        for r in results:
            chunks.append(np.array(r.audio, dtype="float32").reshape(-1))
            sr = int(getattr(r, "sample_rate", sr))
        return np.concatenate(chunks), sr


class Chatterbox:
    name = "chatterbox"

    def __init__(self, args):
        import perth
        import torch
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        if getattr(perth, "PerthImplicitWatermarker", None) is None:
            # 워터마크 모듈이 import 에 실패하면 None 이 된다 (pkg_resources 없음 등). 비교에는 필요 없어서 빈 것으로
            perth.PerthImplicitWatermarker = perth.DummyWatermarker
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        self.model = ChatterboxMultilingualTTS.from_pretrained(device=device)
        self.sr = int(self.model.sr)
        self.ref = args.ref
        self.voices = ["ref" if args.ref else "default"]

    def synth(self, text, voice):
        kw = {"language_id": "ko"}
        if self.ref:
            kw["audio_prompt_path"] = self.ref
        wav = self.model.generate(text, **kw)
        return wav.detach().cpu().numpy(), self.sr


ENGINES = {"supertonic": Supertonic, "qwen": Qwen, "chatterbox": Chatterbox}


# ---------- 옆에서 대화 모델 돌리기 (--with-llm) ----------

def llm_load_loop(base, model, stop):
    import httpx
    msg = [{"role": "user", "content": "아이에게 들려줄 긴 동화를 하나 지어 줘. /no_think"}]
    with httpx.Client(timeout=120.0) as c:
        try:
            c.post(f"{base}/load-model", json={"model": model})
        except httpx.HTTPError:
            pass
        while not stop.is_set():
            try:
                with c.stream("POST", f"{base}/chat/completions",
                              json={"model": model, "messages": msg, "stream": True, "max_tokens": 300,
                                    "chat_template_kwargs": {"enable_thinking": False}}) as r:
                    for _ in r.iter_lines():
                        if stop.is_set():
                            break
            except httpx.HTTPError as e:
                print(f"  [llm] 요청 실패: {e}", file=sys.stderr)
                stop.wait(2)


# ---------- 한 엔진 실행 (자식 프로세스) ----------

def run_one(args):
    cls = ENGINES[args.only]
    t0 = time.perf_counter()
    eng = cls(args)
    load_s = time.perf_counter() - t0
    print(f"[{eng.name}] 모델 올리기 {load_s:.1f}s  목소리={','.join(eng.voices)}", flush=True)

    stop = threading.Event()
    if args.with_llm:
        threading.Thread(target=llm_load_loop, args=(args.llm_url, args.llm_model, stop), daemon=True).start()
        time.sleep(3)  # 대화 모델이 답을 내기 시작할 때까지

    rows = []
    try:
        for voice in eng.voices:
            t0 = time.perf_counter()
            eng.synth("준비 운동.", voice)  # 첫 호출은 컴파일·캐시 때문에 느려서 빼고 잰다
            warm = time.perf_counter() - t0
            for i, text in enumerate(SENTENCES):
                t0 = time.perf_counter()
                audio, sr = eng.synth(text, voice)
                took = time.perf_counter() - t0
                path = os.path.join(args.out, f"{eng.name}_{voice}_{i:02d}.wav")
                dur = save_wav(path, audio, sr)
                rows.append({"engine": eng.name, "voice": voice, "idx": i, "chars": len(text),
                             "synth_s": round(took, 3), "audio_s": round(dur, 3),
                             "rtf": round(took / dur, 3) if dur else None,
                             "load_s": round(load_s, 1), "warmup_s": round(warm, 2),
                             "with_llm": args.with_llm, "text": text})
                print(f"  {voice:>8} #{i:02d} {took:5.2f}s (소리 {dur:4.1f}s)  {text}", flush=True)
    finally:
        stop.set()
    with open(os.path.join(args.out, f"_rows_{eng.name}.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False)


# ---------- 전체 ----------

def summarize(out, engines):
    rows = []
    for e in engines:
        p = os.path.join(out, f"_rows_{e}.json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                rows += json.load(f)
            os.remove(p)
    if not rows:
        return
    with open(os.path.join(out, "summary.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    print("\n엔진        목소리    올리기  첫문장   평균    최대    RTF")
    for key in sorted({(r["engine"], r["voice"]) for r in rows}):
        rs = [r for r in rows if (r["engine"], r["voice"]) == key]
        s = [r["synth_s"] for r in rs]
        rtf = sum(r["synth_s"] for r in rs) / max(1e-6, sum(r["audio_s"] for r in rs))
        print(f"{key[0]:<11} {key[1]:<8} {rs[0]['load_s']:5.1f}s  {s[0]:5.2f}s  "
              f"{sum(s) / len(s):5.2f}s  {max(s):5.2f}s  {rtf:5.2f}")
    print(f"\nwav 와 summary.csv: {out}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engines", default="supertonic,qwen,chatterbox")
    ap.add_argument("--out", default=os.path.join(ROOT, "tts_bench_out"))
    ap.add_argument("--supertonic-voices", default="F1,F3,M1")
    ap.add_argument("--qwen-model", default="mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16")
    ap.add_argument("--qwen-voices", default="", help="CustomVoice 모델일 때 화자 이름 (쉼표로)")
    ap.add_argument("--ref", default="", help="chatterbox 가 흉내 낼 목소리 wav")
    ap.add_argument("--with-llm", action="store_true", help="mlx-serve 대화 모델을 옆에서 계속 돌린다")
    ap.add_argument("--llm-url", default="http://localhost:11234/v1")
    ap.add_argument("--llm-model", default="ddalcu/Qwen3.6-35B-A3B-MLX-Serve-4bit")
    ap.add_argument("--only", help=argparse.SUPPRESS)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    if args.only:
        run_one(args)
        return

    engines = [e.strip() for e in args.engines.split(",") if e.strip()]
    for e in engines:
        if e not in ENGINES:
            sys.exit(f"모르는 엔진: {e} (가능: {', '.join(ENGINES)})")
        print(f"\n===== {e} =====", flush=True)
        child = [a for a in sys.argv[1:]] + ["--only", e]
        rc = subprocess.call([sys.executable, os.path.abspath(__file__)] + child)
        if rc != 0:
            print(f"[{e}] 실패 (종료 코드 {rc}). 위 오류를 확인하세요. 설치가 안 됐으면 이 파일 맨 위의 설치 방법 참고.")
    summarize(args.out, engines)


if __name__ == "__main__":
    main()
