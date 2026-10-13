"""Measure the same owned Ollama model on CPU and native Metal."""
import argparse
import json
from pathlib import Path
import statistics
import time
import threading
import psutil
import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:11435")
    parser.add_argument("--model", default="llama3.2:1b")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    reports = {}
    process_state = Path(__file__).resolve().parents[2] / ".mac-runtime/processes.json"
    pid = json.loads(process_state.read_text())["ollama"]["pid"]
    with httpx.Client(timeout=600) as client:
        client.post(f"{args.url}/api/pull", json={"model": args.model, "stream": False}).raise_for_status()
        for mode, gpu in [("cpu", 0), ("metal", -1)]:
            client.post(f"{args.url}/unload").raise_for_status()
            runs = []
            peak = [0]; done = threading.Event(); swap = psutil.swap_memory().used
            def monitor():
                while not done.wait(.1):
                    try:
                        root = psutil.Process(pid)
                        peak[0] = max(peak[0], sum(process.memory_info().rss for process in [root, *root.children(recursive=True)]))
                    except psutil.Error: pass
            thread = threading.Thread(target=monitor, daemon=True); thread.start()
            for index in range(4):
                start = time.perf_counter()
                response = client.post(f"{args.url}/api/generate", json={"model": args.model, "stream": False,
                    "prompt": "Explain how to edit a podcast into a short video, step by step, in detail.",
                    "options": {"temperature": 0, "seed": 42, "num_predict": 128, "num_ctx": 2048, "num_gpu": gpu}})
                response.raise_for_status(); result = response.json()
                runs.append({"kind": "cold" if index == 0 else "warm", "seconds": time.perf_counter() - start,
                             "eval_count": result.get("eval_count"), "eval_duration_ns": result.get("eval_duration"),
                             "load_duration_ns": result.get("load_duration"), "response": result.get("response")})
            done.set(); thread.join()
            reports[mode] = {"runs": runs, "warm_median_seconds": statistics.median(run["seconds"] for run in runs[1:]), "peak_owned_process_tree_rss_mb": peak[0] / 1048576, "swap_growth_mb": (psutil.swap_memory().used - swap) / 1048576}
        reports["ollama_version"] = client.get(f"{args.url}/api/version").json()
        tags = client.get(f"{args.url}/api/tags"); tags.raise_for_status()
        reports["model_metadata"] = next(model for model in tags.json()["models"] if model["name"] == args.model)
        reports["responses_identical"] = reports["cpu"]["runs"][1]["response"] == reports["metal"]["runs"][1]["response"]
        reports["speedup"] = reports["cpu"]["warm_median_seconds"] / reports["metal"]["warm_median_seconds"]
        client.post(f"{args.url}/unload").raise_for_status()
    args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_text(json.dumps(reports, indent=2))
    print(f"Ollama Metal speedup: {reports['speedup']:.2f}x")


if __name__ == "__main__": main()
