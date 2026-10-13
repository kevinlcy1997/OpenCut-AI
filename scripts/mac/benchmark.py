"""Fixed-fixture native speech benchmark; run in the Whisper environment."""
import argparse
from array import array
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import statistics
import sys
import threading
import time

import psutil


def normalize(word):
    return re.sub(r"[^\w]", "", word.lower())


def word_metrics(reference, predicted):
    refs = [word for word in reference if normalize(word["word"])]
    preds = [word for word in predicted if normalize(word["word"])]
    a, b = [normalize(w["word"]) for w in refs], [normalize(w["word"]) for w in preds]
    matrix = [array("I", range(len(b) + 1))]
    for i, left in enumerate(a, 1):
        row = array("I", [i])
        for j, right in enumerate(b, 1):
            row.append(min(row[j - 1] + 1, matrix[i - 1][j] + 1, matrix[i - 1][j - 1] + (left != right)))
        matrix.append(row)
    i, j = len(a), len(b)
    timing = []
    while i and j:
        if matrix[i][j] == matrix[i - 1][j - 1] + (a[i - 1] != b[j - 1]):
            if a[i - 1] == b[j - 1]:
                timing.extend([abs(refs[i - 1][key] - preds[j - 1][key]) for key in ("start", "end")])
            i -= 1; j -= 1
        elif matrix[i][j] == matrix[i - 1][j] + 1:
            i -= 1
        else:
            j -= 1
    return {"wer": matrix[-1][-1] / max(1, len(a)),
            "median_boundary_error_ms": statistics.median(timing) * 1000 if timing else None,
            "matched_boundary_count": len(timing)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--speech", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--backend", choices=["mlx", "faster-whisper"], required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--precision", choices=["float32", "float16"], default="float32")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "services/whisper-service"))
    os.environ.update(WHISPER_BACKEND=args.backend, WHISPER_DEVICE="cpu", WHISPER_MODEL_SIZE=args.model,
                      WHISPER_MLX_PRECISION=args.precision,
                      UPLOAD_DIR=str(root / ".mac-runtime/benchmark-uploads"))
    os.environ.setdefault("HF_HOME", str(root / ".mac-runtime/models"))
    process = psutil.Process()
    peak = [0]
    done = threading.Event()
    def monitor():
        while not done.wait(.1):
            peak[0] = max(peak[0], process.memory_info().rss)
    thread = threading.Thread(target=monitor, daemon=True)
    thread.start()
    swap_before = psutil.swap_memory().used
    from app import whisper_service
    start = time.perf_counter()
    whisper_service.load_model(args.model)
    load_seconds = time.perf_counter() - start
    durations = []
    reference = json.loads(args.reference.read_text())["words"]
    runs = []
    try:
        for index in range(4):
            start = time.perf_counter()
            result = whisper_service.transcribe(str(args.speech), language="en")
            seconds = time.perf_counter() - start
            durations.append(seconds)
            words = [word.model_dump() for segment in result.segments for word in segment.words]
            runs.append({"kind": "cold" if index == 0 else "warm", "seconds": seconds, "quality": word_metrics(reference, words)})
            print(f"{args.backend} {index}: {seconds:.2f}s", flush=True)
        repo = f"models--mlx-community--whisper-{args.model}-mlx" if args.backend == "mlx" else f"models--Systran--faster-whisper-{args.model}"
        revision_path = Path(os.environ["HF_HOME"]) / "hub" / repo / "refs/main"
        revision = getattr(whisper_service._model, "revision", None) or (revision_path.read_text().strip() if revision_path.exists() else None)
        report = {"model_revision": revision, "backend": args.backend, "device": whisper_service.device, "model": args.model, "precision": args.precision,
                  "platform": platform.platform(), "load_seconds": load_seconds, "runs": runs,
                  "warm_median_seconds": statistics.median(durations[1:]), "peak_rss_mb": peak[0] / 1048576,
                  "swap_growth_mb": (psutil.swap_memory().used - swap_before) / 1048576,
                  "versions": {name: importlib.metadata.version(name) for name in ("faster-whisper", "mlx-whisper")}}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2))
    finally:
        done.set(); thread.join(); whisper_service.unload_model()


if __name__ == "__main__":
    main()
