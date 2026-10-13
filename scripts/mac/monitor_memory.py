"""Sample owned native process trees and host memory after model warm-up."""
import argparse
import json
from pathlib import Path
import time
import psutil


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--minutes", type=float, default=30)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    state = Path(__file__).resolve().parents[2] / ".mac-runtime"
    start = time.monotonic(); baseline_swap = psutil.swap_memory().used
    peaks, samples = {}, []
    last_saved = -10
    while time.monotonic() - start < args.minutes * 60:
        readings = {}
        entries = json.loads((state / "processes.json").read_text())
        for name, entry in entries.items():
            if "pid" not in entry: continue
            try:
                process = psutil.Process(entry["pid"])
                readings[name] = sum(worker.memory_info().rss for worker in [process, *process.children(recursive=True)]) / 1048576
                peaks[name] = max(peaks.get(name, 0), readings[name])
            except psutil.Error: readings[name] = None
        elapsed = time.monotonic() - start
        if elapsed - last_saved >= 10:
            samples.append({"seconds": elapsed, "rss_mb": readings, "available_mb": psutil.virtual_memory().available / 1048576, "swap_growth_mb": (psutil.swap_memory().used-baseline_swap)/1048576})
            report = {"complete": False, "elapsed_seconds": elapsed, "peak_owned_process_tree_rss_mb": peaks, "samples": samples,
                      "limitations": ["Starts after warm-up; excludes the browser and Docker VM process trees", "Host available memory/swap includes other applications", "RSS does not measure total Metal allocation"]}
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2))
            last_saved = elapsed
        time.sleep(.2)
    report["complete"] = True
    report["elapsed_seconds"] = time.monotonic() - start
    report["swap_growth_mb"] = (psutil.swap_memory().used-baseline_swap)/1048576
    args.output.write_text(json.dumps(report, indent=2))


if __name__ == "__main__": main()
