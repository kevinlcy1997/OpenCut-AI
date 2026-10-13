"""Run independently per device/precision to avoid resident-model interference."""
import argparse
import asyncio
import importlib.metadata
import json
import os
from pathlib import Path
import statistics
import sys
import threading
import time
import psutil

PROMPT = "A ceramic teapot on a wooden table beside a window, soft daylight, detailed product photograph"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", choices=["cpu", "mps"], required=True)
    parser.add_argument("--precision", choices=["float32", "float16"], default="float32")
    parser.add_argument("--slicing", choices=["on", "off"], default="on")
    parser.add_argument("--model", default="segmind/tiny-sd")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "services/image-service"))
    os.environ.update(IMAGE_DEVICE=args.device, IMAGE_PRECISION=args.precision, IMAGE_ATTENTION_SLICING=args.slicing,
                      OPENCUT_BENCHMARK_UNVALIDATED="1",
                      DIFFUSION_MODEL=args.model, GENERATED_DIR=str(root / ".mac-runtime/image-benchmark"), UPLOAD_DIR=str(root / ".mac-runtime/image-uploads"))
    os.environ.setdefault("HF_HOME", str(root / ".mac-runtime/models"))
    process = psutil.Process(); peak = [0]; done = threading.Event()
    def monitor():
        while not done.wait(.1): peak[0] = max(peak[0], process.memory_info().rss)
    thread = threading.Thread(target=monitor, daemon=True); thread.start()
    swap = psutil.swap_memory().used
    from app import diffusion_service
    start = time.perf_counter()
    loaded = diffusion_service.load_model(args.model)
    if loaded["status"] != "loaded": raise RuntimeError(loaded)
    load_seconds = time.perf_counter() - start
    runs = []
    try:
        for index in range(4):
            start = time.perf_counter()
            image = asyncio.run(diffusion_service.generate(PROMPT, width=512, height=512, steps=20, seed=42))
            seconds = time.perf_counter() - start
            runs.append({"kind": "cold" if index == 0 else "warm", "seconds": seconds, "image": image})
            print(f"{args.device}/{args.precision}/{args.slicing} {index}: {seconds:.2f}s", flush=True)
        report = {"device": args.device, "precision": args.precision, "slicing": args.slicing, "model": args.model,
                  "prompt": PROMPT, "seed": 42, "width": 512, "height": 512, "steps": 20, "load_seconds": load_seconds,
                  "runs": runs, "warm_median_seconds": statistics.median(r["seconds"] for r in runs[1:]),
                  "peak_rss_mb": peak[0] / 1048576, "swap_growth_mb": (psutil.swap_memory().used - swap) / 1048576,
                  "versions": {name: importlib.metadata.version(name) for name in ("torch", "diffusers", "transformers")}}
        args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_text(json.dumps(report, indent=2))
    finally:
        done.set(); thread.join(); diffusion_service.unload()


if __name__ == "__main__": main()
