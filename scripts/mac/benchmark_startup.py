"""Three fresh-process startup runs; stops only launcher-owned services."""
import argparse
import json
from pathlib import Path
import statistics
import subprocess
import sys
import time
import psutil


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    launcher = root / "scripts/mac/runtime.py"
    state = root / ".mac-runtime"
    runs = []
    for index in range(3):
        subprocess.run([sys.executable, str(launcher), "stop"], check=True, stdout=subprocess.DEVNULL)
        before = psutil.swap_memory().used; peak = 0
        with (state / "startup-benchmark.log").open("ab") as log:
            process = subprocess.Popen([sys.executable, str(launcher), "start"], stdout=log, stderr=log)
            while process.poll() is None:
                try:
                    entries = json.loads((state / "processes.json").read_text())
                    owned = {}
                    for entry in entries.values():
                        if "pid" in entry:
                            worker = psutil.Process(entry["pid"])
                            for child in [worker, *worker.children(recursive=True)]: owned[child.pid] = child
                    peak = max(peak, sum(worker.memory_info().rss for worker in owned.values()))
                except (OSError, ValueError, psutil.Error): pass
                time.sleep(.2)
            if process.returncode: raise RuntimeError("Startup failed; inspect .mac-runtime/startup-benchmark.log")
        report = json.loads((state / "startup.json").read_text())
        runs.append({**report, "peak_owned_process_tree_rss_mb": peak / 1048576, "swap_growth_mb": (psutil.swap_memory().used - before) / 1048576})
        print(f"Startup {index+1}/3: {report['seconds']:.2f}s", flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"runs": runs, "median_seconds": statistics.median(run["seconds"] for run in runs), "limitations": ["Infrastructure images/dependencies are cached", "Process-tree RSS is not total GPU allocation; Docker VM memory is excluded", "Heavy model cold loading is measured separately"]}, indent=2))


if __name__ == "__main__": main()
