"""Native API smoke checks; blocked/licensed services are not counted as passes."""
import argparse
import json
from pathlib import Path
import time
import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    reports = {}
    with httpx.Client(timeout=600) as client:
        for name, port, path, body in [
            ("clip", 8426, "/embed-text", {"text": "A ceramic teapot beside a window"}),
            ("translate", 8427, "/translate", {"text": "Welcome to the podcast.", "source_lang": "eng_Latn", "target_lang": "fra_Latn"}),
        ]:
            start = time.perf_counter()
            try:
                response = client.post(f"http://127.0.0.1:{port}{path}", json=body)
                status = "passed" if response.is_success else "blocked" if response.status_code in {422, 507} else "failed"
                reports[name] = {"status": status, "http_status": response.status_code, "seconds": time.perf_counter() - start, "result": response.json(), "health": client.get(f"http://127.0.0.1:{port}/health").json()}
            except Exception as error:
                reports[name] = {"status": "failed", "error": str(error)}
            client.post(f"http://127.0.0.1:{port}/unload")
        try:
            with args.video.open("rb") as file:
                response = client.post("http://127.0.0.1:8425/detect", files={"file": (args.video.name, file, "video/mp4")}, data={"max_samples": 2, "sample_interval": 1})
            reports["face"] = {"status": "passed" if response.is_success else "failed", "http_status": response.status_code, "result": response.json(), "health": client.get("http://127.0.0.1:8425/health").json()}
            client.post("http://127.0.0.1:8425/unload")
        except Exception as error:
            reports["face"] = {"status": "failed", "error": str(error)}
        reports["tts"] = {"status": "blocked", "reason": "XTTS requires user license acceptance; MPS is not enabled", "health": client.get("http://127.0.0.1:8422/health").json()}
        reports["speaker"] = {"status": "blocked", "reason": "Gated diarization credentials are not configured; MPS is not enabled", "health": client.get("http://127.0.0.1:8424/health").json()}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(reports, indent=2))
    print({name: result["status"] for name, result in reports.items()})


if __name__ == "__main__": main()
