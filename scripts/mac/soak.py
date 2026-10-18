"""Mixed native AI/media soak; blocked operations are reported, never counted as passes."""
import argparse
import json
import math
from pathlib import Path
import time
import httpx
import psutil


def evaluate_native_soak(report, requested_minutes):
    """Native-only evidence cannot approve the complete editing-session gate."""
    operations = report.get("operations", [])
    required = {"transcribe", "llm", "image", "media"}
    criteria = {
        "duration": requested_minutes >= 30 and report.get("elapsed_seconds", 0) >= 1800,
        "all_workloads_executed": required <= {item["operation"] for item in operations},
        "all_operations_passed": bool(operations) and all(item["status"] == "passed" for item in operations),
        "swap_growth": report.get("swap_growth_mb", float("inf")) <= 1024,
    }
    return {"scope": "native services only; no browser editing workload",
            "native_checks": criteria, "native_checks_passed": all(criteria.values()),
            "full_stability_acceptance_passed": False,
            "unverified": ["30-minute browser editing/playback/export with AI", "browser and GPU memory growth", "swap measured after a defined warm-up", "sustained allocation growth across the full session"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--speech", type=Path, required=True)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--minutes", type=float, default=30)
    parser.add_argument("--llm-model", default="qwen2.5:0.5b")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not math.isfinite(args.minutes) or args.minutes <= 0:
        parser.error("--minutes must be a finite positive number")
    args.speech = args.speech.resolve(strict=True)
    args.video = args.video.resolve(strict=True)
    root = Path(__file__).resolve().parents[2]
    state = root / ".mac-runtime"
    token = (state / "token").read_text().strip()
    headers = {"Authorization": f"Bearer {token}"}
    operations = []
    peaks = {}
    with httpx.Client(timeout=600) as client:
        # Download is not an inference operation and does not reserve model RAM.
        pull = client.post("http://127.0.0.1:11435/api/pull", json={"model": args.llm_model, "stream": False})
        pull.raise_for_status()
        media = "http://127.0.0.1:8428"
        with args.video.open("rb") as file:
            upload = client.post(f"{media}/assets", headers=headers, files={"file": (args.video.name, file, "video/mp4")})
        upload.raise_for_status(); asset = upload.json()["asset_id"]
        # Preparation and downloads are outside the sustained workload interval.
        start = time.monotonic(); swap_before = psutil.swap_memory().used
        try:
            while time.monotonic() - start < args.minutes * 60:
                for name in ("transcribe", "llm", "image", "media"):
                    before = time.monotonic()
                    try:
                        if name == "transcribe":
                            with args.speech.open("rb") as file:
                                response = client.post("http://127.0.0.1:8421/transcribe", files={"file": (args.speech.name, file, "audio/wav")}, data={"language": "en"})
                        elif name == "llm":
                            response = client.post("http://127.0.0.1:11435/api/generate", json={"model": args.llm_model, "stream": False, "prompt": "Give three practical podcast editing tips.", "options": {"num_predict": 64, "num_ctx": 2048, "temperature": 0}})
                        elif name == "image":
                            if psutil.virtual_memory().available / 1048576 < 5500:
                                operations.append({"operation": name, "status": "blocked", "reason": "Insufficient measured headroom for validated float32 image working set"})
                                continue
                            response = client.post("http://127.0.0.1:8423/load", params={"model_name": "segmind/tiny-sd"})
                            response.raise_for_status()
                            response = client.post("http://127.0.0.1:8423/generate", json={"prompt": "A ceramic teapot beside a window", "steps": 20, "seed": 42, "width": 512, "height": 512})
                        else:
                            response = client.post(f"{media}/jobs", headers=headers, json={"kind": "proxy", "clips": [{"asset_id": asset, "duration": 60}], "width": 1280, "height": 720, "fps": 30, "bitrate": 2_000_000})
                            response.raise_for_status(); job = response.json()["job_id"]
                            while True:
                                response = client.get(f"{media}/jobs/{job}", headers=headers)
                                response.raise_for_status(); status = response.json()
                                if status["state"] in {"complete", "failed", "cancelled"}: break
                                time.sleep(.25)
                            if status["state"] != "complete": raise RuntimeError(status)
                        response.raise_for_status()
                        operations.append({"operation": name, "status": "passed", "seconds": time.monotonic() - before})
                    except Exception as error:
                        operations.append({"operation": name, "status": "failed", "error": str(error)})
                    processes = json.loads((state / "processes.json").read_text())
                    for service, entry in processes.items():
                        if "pid" in entry and psutil.pid_exists(entry["pid"]):
                            peaks[service] = max(peaks.get(service, 0), psutil.Process(entry["pid"]).memory_info().rss / 1048576)
                    report = {"elapsed_seconds": time.monotonic() - start, "operations": operations, "peak_process_rss_mb": peaks,
                              "swap_growth_mb": (psutil.swap_memory().used - swap_before) / 1048576,
                              "passed": False, "complete": False}
                    args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_text(json.dumps(report, indent=2))
                print(f"Soak: {(time.monotonic()-start)/60:.1f} minutes, {len(operations)} operations", flush=True)
                time.sleep(5)
        finally:
            client.delete(f"{media}/assets/{asset}", headers=headers)
            client.post("http://127.0.0.1:11435/unload")
    report["complete"] = True
    report.update(evaluate_native_soak(report, args.minutes))
    # Retain the legacy field conservatively: this script cannot approve the
    # complete editing/AI acceptance gate, even when native checks all pass.
    report["passed"] = report["full_stability_acceptance_passed"]
    args.output.write_text(json.dumps(report, indent=2))
    print(f"Native checks: {report['native_checks_passed']}; full editing stability acceptance: {report['passed']}")


if __name__ == "__main__": main()
