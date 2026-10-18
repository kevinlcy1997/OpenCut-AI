"""Live native cancellation/queue probe; use only launcher-managed test fixtures."""
import argparse
import asyncio
import json
import hashlib
import shutil
from pathlib import Path
import time
import httpx
import psutil

ROOT = Path(__file__).resolve().parents[2]


async def validate(video, report_path):
    state = ROOT / ".mac-runtime"
    token = (state / "token").read_text().strip()
    entries = json.loads((state / "processes.json").read_text())
    worker = psutil.Process(entries["media-service"]["pid"])
    headers = {"Authorization": f"Bearer {token}"}
    base = "http://127.0.0.1:8428"
    asset = None
    submitted = []
    peak = 0
    samples = 0
    monitoring = True
    ffmpeg_executable = Path(shutil.which("ffmpeg") or "missing-ffmpeg").resolve()
    async def monitor():
        nonlocal peak, samples
        while monitoring:
            encoders = []
            for process in worker.children(recursive=True):
                try:
                    if Path(process.exe()).resolve() == ffmpeg_executable: encoders.append(process)
                except psutil.NoSuchProcess:
                    pass
            peak = max(peak, len(encoders)); samples += 1
            await asyncio.sleep(.01)
    async with httpx.AsyncClient(timeout=120, headers=headers) as client:
        capability = (await client.get(base + "/capabilities")); capability.raise_for_status()
        if not capability.json()["hardware_available"]:
            raise RuntimeError("VideoToolbox unavailable; live cancellation not validated")
        with video.open("rb") as source:
            upload = await client.post(base + "/assets", files={"file": (video.name, source, "video/mp4")})
        upload.raise_for_status(); asset = upload.json()["asset_id"]
        async def create(kind, width, height):
            response = await client.post(base + "/jobs", json={"kind": kind, "clips": [{"asset_id": asset, "duration": 60}], "width": width, "height": height, "fps": 30, "bitrate": 2_000_000})
            response.raise_for_status(); key = response.json()["job_id"]; submitted.append(key); return key
        async def status(key):
            response = await client.get(base + f"/jobs/{key}"); response.raise_for_status(); return response.json()
        async def until(key, states):
            deadline = time.monotonic() + 120
            while True:
                value = await status(key)
                if value["state"] in states: return value
                if time.monotonic() > deadline: raise RuntimeError("Job did not reach the required state")
                await asyncio.sleep(.02)
        observer = asyncio.create_task(monitor())
        try:
            first = await create("export", 3840, 2160)
            first_active = await until(first, {"running", "failed", "complete"})
            if first_active["state"] != "running": raise RuntimeError("First job did not remain active for the cancellation probe")
            second = await create("proxy", 1280, 720)
            queued = await status(second)
            if queued["state"] != "queued": raise RuntimeError("Second job bypassed active encoder ownership")
            denied = await client.delete(base + f"/assets/{asset}")
            if denied.status_code != 409: raise RuntimeError("Active media asset was not protected")
            cancelled = await client.delete(base + f"/jobs/{first}"); cancelled.raise_for_status()
            first_state = await status(first)
            partial_removed = not (state / "media" / f"{first}.mp4").exists()
            second_active = await until(second, {"running", "failed", "complete"})
            if second_active["state"] != "running": raise RuntimeError("Second job did not remain active for queued cancellation probe")
            third = await create("proxy", 1280, 720)
            third_queued = (await status(third))["state"] == "queued"
            queued_cancel = await client.delete(base + f"/jobs/{third}"); queued_cancel.raise_for_status()
            third_state = await status(third)
            completed = await until(second, {"complete", "failed", "cancelled"})
            output = await client.get(base + f"/jobs/{second}/download")
            download_ready = output.status_code == 200 and len(output.content) > 0
            passed = first_state["state"] == "cancelled" and partial_removed and third_queued and third_state["state"] == "cancelled" and completed["state"] == "complete" and download_ready and peak == 1 and samples > 0
            report = {"passed": passed, "media_implementation_sha256": hashlib.sha256((ROOT / "services/media-service/app.py").read_bytes()).hexdigest(),
                      "encoder_identity": "Resolved ffmpeg executable path, not process display name", "first_cancelled": first_state["state"] == "cancelled", "partial_output_removed": partial_removed,
                      "second_observed_queued_then_running": queued["state"] == "queued" and second_active["state"] == "running",
                      "active_asset_delete_http": denied.status_code, "queued_job_cancelled": third_queued and third_state["state"] == "cancelled",
                      "following_job_completed": completed["state"] == "complete", "download_bytes": len(output.content) if download_ready else 0,
                      "encoder_process_peak_sampled": peak, "process_samples": samples,
                      "limitations": ["10ms sampling cannot prove absence of sub-sample process overlap; coroutine regression tests establish lock ownership", "Native service HTTP only, not browser export or a sustained editing session"]}
            Path(report_path).write_text(json.dumps(report, indent=2) + "\n")
            if not passed: raise RuntimeError("Live media cancellation checks failed; inspect report")
            print("Live cancellation, queue ordering, input protection and following-job download passed")
        finally:
            monitoring = False
            await observer
            for key in submitted:
                response = await client.delete(base + f"/jobs/{key}"); response.raise_for_status()
            if asset:
                response = await client.delete(base + f"/assets/{asset}"); response.raise_for_status()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", type=Path, default=ROOT / ".mac-runtime/fixtures/video-4k-60s.mp4")
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    asyncio.run(validate(args.video.resolve(strict=True), args.report))
