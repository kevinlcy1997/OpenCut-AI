"""Loopback native media jobs. Automatic routing requires recorded parity gates."""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import logging
import math
import os
import platform
from pathlib import Path
import secrets
import shutil
import time
import tempfile
import uuid
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, ConfigDict

STATE = Path(os.getenv("OPENCUT_MAC_STATE", ".mac-runtime"))
STORE = STATE / "media"
LIMIT = 10 * 1024**3
ASSET_LIMIT = 2 * 1024**3
TOKEN = os.getenv("OPENCUT_MEDIA_TOKEN", "")
ORIGINS = {"http://localhost:3000", "http://127.0.0.1:3000"}
INPUT_FORMATS = "mov,matroska,webm,wav,mp3,flac,ogg,aac,mpegts"
INPUT_OPTIONS = ["-protocol_whitelist", "file,pipe", "-format_whitelist", INPUT_FORMATS]
assets = {}
jobs = {}
tasks = {}
worker_lock = asyncio.Lock()
upload_spool_reserved_bytes = 0
logger = logging.getLogger(__name__)


class Clip(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    asset_id: str
    start: float = Field(default=0, ge=0)
    duration: float = Field(gt=0, le=14400)


class JobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    kind: str = "export"
    clips: list[Clip] = Field(min_length=1, max_length=100)
    width: int = Field(default=1920, ge=2, le=4096)
    height: int = Field(default=1080, ge=2, le=4096)
    fps: float = Field(default=30, ge=1, le=60)
    bitrate: int = Field(default=8_000_000, ge=100_000, le=100_000_000)
    audio_asset_id: str | None = None
    validated_profile: Literal["4k-sdr-30fps"] | None = None


def disk_usage():
    return upload_spool_reserved_bytes + sum(path.stat().st_size for folder in (STORE, STATE / "browser-benchmarks") for path in folder.glob("*") if path.is_file())


def command(request, output):
    if request.kind not in {"proxy", "export"} or request.width % 2 or request.height % 2:
        raise ValueError("Use proxy/export with even output dimensions")
    args = ["ffmpeg", "-nostdin", "-y"]
    filters = []
    for index, clip in enumerate(request.clips):
        if clip.asset_id not in assets:
            raise ValueError("Unknown asset ID")
        info = assets[clip.asset_id].get("metadata", {})
        if request.validated_profile and (info.get("codec") != "h264" or info.get("width") != 3840 or info.get("height") != 2160 or abs(info.get("fps", 0) - 30) > .001):
            raise ValueError("Source is outside the validated native media profile")
        if request.validated_profile and (info.get("pixel_format") not in {"yuv420p", "nv12"} or info.get("color_primaries") not in {None, "unknown", "bt709"}):
            raise ValueError("Source color/bit-depth is outside the validated native profile")
        if info.get("hdr"):
            raise ValueError("HDR is not supported by the native parity profile")
        if info.get("rotated") or (info.get("fps") and abs(info["fps"] - request.fps) > .001) or info.get("variable_rate"):
            raise ValueError("Native parity profile requires unrotated constant-rate footage matching output fps")
        source_frame = clip.start * request.fps
        if not math.isfinite(source_frame) or source_frame > 2**53 - 1:
            raise ValueError("Source frame index exceeds the supported numeric range")
        if abs(source_frame - round(source_frame)) > .0001:
            raise ValueError("Native trims require frame-aligned source times")
        if info.get("duration") and clip.start + clip.duration > info["duration"] + 1 / request.fps:
            raise ValueError("Clip exceeds its source duration")
        args += [*INPUT_OPTIONS, "-hwaccel", "videotoolbox", "-i", str(assets[clip.asset_id]["path"])]
        if len(request.clips) > 1 and request.kind == "proxy":
            raise ValueError("Proxy jobs require exactly one source clip")
        frames = round(clip.duration * request.fps)
        if frames < 1 or abs(frames / request.fps - clip.duration) > .0001:
            raise ValueError("Native export requires frame-aligned clip durations")
        filters.append(f"[{index}:v]trim=start={clip.start}:duration={clip.duration},setpts=PTS-STARTPTS,"
                       f"scale={request.width}:{request.height}:force_original_aspect_ratio=decrease,"
                       f"pad={request.width}:{request.height}:(ow-iw)/2:(oh-ih)/2:color=black,"
                       f"setsar=1,fps={request.fps},tpad=stop_mode=clone:stop=1,trim=end_frame={frames}[v{index}]")
    joined = "".join(f"[v{i}]" for i in range(len(request.clips)))
    filters.append(f"{joined}concat=n={len(request.clips)}:v=1:a=0[outv]")
    if request.audio_asset_id:
        if request.audio_asset_id not in assets:
            raise ValueError("Unknown audio asset ID")
        if assets[request.audio_asset_id].get("metadata", {}).get("audio_channels", 2) > 2:
            raise ValueError("Native audio parity profile supports mono/stereo only")
        args += [*INPUT_OPTIONS, "-i", str(assets[request.audio_asset_id]["path"])]
    args += ["-filter_complex", ";".join(filters), "-map", "[outv]"]
    if request.audio_asset_id:
        args += ["-map", f"{len(request.clips)}:a:0", "-c:a", "aac", "-b:a", "192k"]
    else:
        args += ["-an"]
    args += ["-c:v", "h264_videotoolbox", "-allow_sw", "0", "-b:v", str(request.bitrate),
             "-pix_fmt", "nv12", "-r", str(request.fps), "-frames:v", str(sum(round(c.duration * request.fps) for c in request.clips)),
             "-t", str(sum(clip.duration for clip in request.clips)),
             "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(output)]
    return args


async def probe(path):
    process = await asyncio.create_subprocess_exec("ffprobe", "-v", "error", *INPUT_OPTIONS, "-show_streams", "-show_format", "-of", "json", str(path), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        output, _ = await asyncio.wait_for(process.communicate(), 30)
    except BaseException:
        if process.returncode is None:
            process.kill(); await process.wait()
        raise
    if process.returncode:
        raise HTTPException(422, "Uploaded asset is not valid audio/video")
    info = json.loads(output)
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    def rate(value):
        try:
            first, last = value.split("/")
            return float(first) / float(last)
        except (ValueError, ZeroDivisionError, AttributeError):
            return 0
    return {"duration": float(info.get("format", {}).get("duration", 0)),
            "width": video.get("width"), "height": video.get("height"),
            "codec": video.get("codec_name"), "pixel_format": video.get("pix_fmt"), "color_primaries": video.get("color_primaries"),
            "video": any(s.get("codec_type") == "video" for s in streams),
            "audio": any(s.get("codec_type") == "audio" for s in streams),
            "hdr": any(s.get("color_transfer") in {"smpte2084", "arib-std-b67"} or any("dv_profile" in data or "Mastering display" in data.get("side_data_type", "") for data in s.get("side_data_list", [])) for s in streams),
            "fps": rate(video.get("avg_frame_rate", "0/1")),
            "variable_rate": abs(rate(video.get("avg_frame_rate", "0/1")) - rate(video.get("r_frame_rate", "0/1"))) > .001,
            "rotated": any(s.get("rotation", 0) != 0 for s in video.get("side_data_list", [])),
            "audio_channels": max((s.get("channels", 0) for s in streams if s.get("codec_type") == "audio"), default=0)}


_hardware_available = None
_ffmpeg_version = None
_hardware_lock = asyncio.Lock()


async def capabilities():
    global _hardware_available, _ffmpeg_version
    async with _hardware_lock:
        if _hardware_available is None:
            _hardware_available = False
            if shutil.which("ffmpeg"):
                proc = None
                try:
                    version = await asyncio.create_subprocess_exec("ffmpeg", "-version", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                    version_output, _ = await version.communicate()
                    _ffmpeg_version = version_output.decode(errors="replace").splitlines()[0]
                    # Listing an encoder does not establish usable hardware.
                    proc = await asyncio.create_subprocess_exec("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=size=128x128:rate=30", "-frames:v", "1", "-pix_fmt", "nv12", "-c:v", "h264_videotoolbox", "-allow_sw", "0", "-f", "null", "-", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                    await asyncio.wait_for(proc.wait(), timeout=10)
                    _hardware_available = proc.returncode == 0
                except (OSError, asyncio.TimeoutError):
                    if proc and proc.returncode is None:
                        proc.kill(); await proc.wait()
    hardware = _hardware_available
    gates_path = STATE / "media-gates.json"
    gates = json.loads(gates_path.read_text()) if gates_path.exists() else {}
    automatic = {}
    for kind in ("proxy", "export"):
        gate = gates.get(kind, {})
        profile = gate.get("profile", {})
        width, height = (1280, 720) if kind == "proxy" else (3840, 2160)
        validated = profile.get("source") == "4k-sdr-30fps" and profile.get("output_width") == width and profile.get("output_height") == height and gate.get("hardware_model") == os.getenv("OPENCUT_MAC_HARDWARE") and gate.get("implementation_sha256") == hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        validated = validated and bool(_ffmpeg_version) and gate.get("ffmpeg_version") == _ffmpeg_version and gate.get("macos_major") == platform.mac_ver()[0].split(".")[0]
        automatic[kind] = hardware and validated and gate.get("parity_passed") is True and gate.get("speedup", 0) >= 1.25
    return {"hardware_available": hardware, "automatic": automatic,
            "ffmpeg_version": _ffmpeg_version,
            "validated_browser": {kind: gates.get(kind, {}).get("browser_version") for kind in ("proxy", "export")},
            "experimental": True, "supported": ["cuts", "trims", "contain-scale", "pre-mixed-audio"],
            "excluded": ["effects", "transitions", "text", "masks", "speed-changes", "HDR"]}


def cleanup_expired():
    now = time.time()
    protected = {asset for job in jobs.values() if job["state"] in {"queued", "running"} for asset in job["asset_ids"]}
    for asset, info in list(assets.items()):
        if asset not in protected and now - info["used"] > 3600:
            try:
                info["path"].unlink(missing_ok=True)
            except OSError as error:
                logger.warning("Could not expire native asset %s: %s", asset, error)
                continue
            del assets[asset]
    for key, job in list(jobs.items()):
        if job["state"] not in {"queued", "running"} and now - job["updated"] > 3600:
            try:
                (STORE / f"{key}.mp4").unlink(missing_ok=True)
            except OSError as error:
                logger.warning("Could not expire native job %s: %s", key, error)
                continue
            del jobs[key]


async def cleanup():
    while True:
        await asyncio.sleep(60)
        # One inaccessible file must not kill expiry for the whole worker.
        # Keep failed entries so the next sweep can retry them.
        cleanup_expired()


@asynccontextmanager
async def lifespan(app):
    STORE.mkdir(parents=True, exist_ok=True)
    # Jobs are session-local; remove abandoned files on restart.
    for path in STORE.glob("*"):
        if path.is_file():
            path.unlink()
    spool = STORE / "spool"
    spool.mkdir(exist_ok=True)
    previous_tempdir = tempfile.tempdir
    tempfile.tempdir = str(spool)
    task = asyncio.create_task(cleanup())
    yield
    task.cancel()
    for running in list(tasks.values()):
        running.cancel()
    await asyncio.gather(task, *list(tasks.values()), return_exceptions=True)
    tempfile.tempdir = previous_tempdir


app = FastAPI(lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, error: RequestValidationError):
    # JSON numeric exponents can overflow to inf during parsing. Pydantic rejects
    # them, but the original non-finite input must also be safe to report as JSON.
    detail = jsonable_encoder(error.errors(), custom_encoder={float: lambda value: value if math.isfinite(value) else str(value)})
    return JSONResponse({"detail": detail}, status_code=422)

app.add_middleware(CORSMiddleware, allow_origins=list(ORIGINS), allow_methods=["GET", "POST", "DELETE"], allow_headers=["Authorization", "Content-Type"])


@app.middleware("http")
async def authorize(request: Request, call_next):
    if request.method == "OPTIONS" or request.url.path == "/health":
        return await call_next(request)
    origin = request.headers.get("origin")
    if origin and origin not in ORIGINS:
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": "Origin denied"}, status_code=403)
    if not TOKEN or not secrets.compare_digest(request.headers.get("authorization", ""), f"Bearer {TOKEN}"):
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": "Runtime token required"}, status_code=401)
    return await call_next(request)


class UploadBodyLimit:
    """Bound multipart spool space before FastAPI parses the uploaded body."""
    def __init__(self, app):
        self.app = app
        self.lock = asyncio.Lock()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"] != "/assets":
            return await self.app(scope, receive, send)
        from fastapi.responses import JSONResponse
        maximum = ASSET_LIMIT + 1024 * 1024
        global upload_spool_reserved_bytes
        async with self.lock:
            if disk_usage() + 2 * maximum > LIMIT:
                return await JSONResponse({"detail": "Insufficient temporary upload space"}, status_code=413)(scope, receive, send)
            total = 0
            async def limited_receive():
                nonlocal total
                message = await receive()
                total += len(message.get("body", b""))
                if total > maximum:
                    raise HTTPException(413, "Upload body exceeds native storage limit")
                return message
            # Multipart TemporaryFile spools can be unlinked while still open,
            # so directory stat totals cannot account for them. Reserve their
            # maximum size until parsing, destination copy and file.close finish.
            # Concurrent encoder quota checks must see this reservation too.
            upload_spool_reserved_bytes += maximum
            try:
                return await self.app(scope, limited_receive, send)
            finally:
                upload_spool_reserved_bytes -= maximum


app.add_middleware(UploadBodyLimit)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "native-media"}


@app.get("/capabilities")
async def get_capabilities():
    return await capabilities()


@app.post("/assets")
async def upload(file: UploadFile = File(...)):
    asset_id = uuid.uuid4().hex
    path = STORE / asset_id
    size = 0
    digest = hashlib.sha256()
    try:
        with path.open("xb") as output:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > ASSET_LIMIT or disk_usage() + len(chunk) > LIMIT:
                    raise HTTPException(413, "Native media storage limit exceeded")
                digest.update(chunk)
                output.write(chunk)
        metadata = await probe(path)
        assets[asset_id] = {"path": path, "used": time.time(), "sha256": digest.hexdigest(), "metadata": metadata}
        return {"asset_id": asset_id, "sha256": digest.hexdigest(), "size": size}
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()


async def execute(job_id, request):
    try:
        # Retain serialization until encoder termination and partial-file cleanup
        # finish, including cancellation. Queued jobs must not overlap that work.
        async with worker_lock:
            await _execute_locked(job_id, request)
    except asyncio.CancelledError:
        jobs[job_id].update(state="cancelled", updated=time.time())
        tasks.pop(job_id, None)
        raise


async def _execute_locked(job_id, request):
    job = jobs[job_id]
    output = STORE / f"{job_id}.mp4"
    process = None
    try:
        job.update(state="running", updated=time.time())
        if disk_usage() + sum(c.duration for c in request.clips) * request.bitrate / 8 > LIMIT:
            raise RuntimeError("Insufficient temporary media quota for this export")
        process = await asyncio.create_subprocess_exec(*command(request, output), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        async def errors():
            tail = b""
            while chunk := await process.stderr.read(4096):
                tail = (tail + chunk)[-4096:]
            return tail
        error_task = asyncio.create_task(errors())
        try:
            while line := await process.stdout.readline():
                if line.startswith(b"out_time_us="):
                    try:
                        job["progress"] = min(.99, int(line.split(b"=")[1]) / 1_000_000 / sum(c.duration for c in request.clips))
                    except ValueError:
                        pass
                if disk_usage() > LIMIT:
                    raise RuntimeError("Native media storage limit exceeded while encoding")
            await process.wait()
            stderr = await error_task
            if process.returncode:
                raise RuntimeError(stderr.decode(errors="replace"))
        finally:
            if not error_task.done():
                error_task.cancel()
                await asyncio.gather(error_task, return_exceptions=True)
        job.update(state="complete", progress=1, updated=time.time())
    except asyncio.CancelledError:
        job.update(state="cancelled", updated=time.time())
        raise
    except Exception as error:
        job.update(state="failed", error=str(error)[-2048:], updated=time.time())
    finally:
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        try:
            if job["state"] != "complete":
                output.unlink(missing_ok=True)
        except OSError as error:
            job.update(error=f"{job.get('error', '')}; Temporary output cleanup failed: {error}"[-2048:], updated=time.time())
        finally:
            tasks.pop(job_id, None)


@app.post("/jobs", status_code=202)
async def create_job(request: JobRequest):
    if not (await capabilities())["hardware_available"]:
        raise HTTPException(503, "VideoToolbox encoder unavailable")
    if len(tasks) >= 4:
        raise HTTPException(429, "Native media queue is full")
    try:
        command(request, STORE / "validation.mp4")
    except ValueError as error:
        raise HTTPException(422, str(error))
    job_id = uuid.uuid4().hex
    asset_ids = [c.asset_id for c in request.clips] + ([request.audio_asset_id] if request.audio_asset_id else [])
    for asset in asset_ids:
        assets[asset]["used"] = time.time()
    jobs[job_id] = {"id": job_id, "state": "queued", "progress": 0, "updated": time.time(), "asset_ids": asset_ids}
    tasks[job_id] = asyncio.create_task(execute(job_id, request))
    return {"job_id": job_id}


@app.get("/jobs/{job_id}")
async def status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Unknown job")
    return {key: value for key, value in jobs[job_id].items() if key != "asset_ids"}


@app.delete("/jobs/{job_id}")
async def cancel(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Unknown job")
    if job_id in tasks:
        task = tasks[job_id]
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        jobs[job_id].update(state="cancelled", updated=time.time())
        tasks.pop(job_id, None)
    return {"state": jobs[job_id]["state"]}


@app.get("/jobs/{job_id}/download")
async def download(job_id: str):
    if job_id not in jobs or jobs[job_id]["state"] != "complete":
        raise HTTPException(404, "Output is not ready")
    return FileResponse(STORE / f"{job_id}.mp4", media_type="video/mp4", filename="export.mp4")


@app.delete("/assets/{asset_id}")
async def delete_asset(asset_id: str):
    if any(asset_id in job["asset_ids"] and job["state"] in {"running", "queued"} for job in jobs.values()):
        raise HTTPException(409, "Asset is in use")
    info = assets.get(asset_id)
    if info:
        info["path"].unlink(missing_ok=True)
        assets.pop(asset_id, None)
    return {"deleted": bool(info)}


@app.get("/benchmark/fixtures/{name}")
async def fixture(name: str):
    if os.getenv("OPENCUT_NATIVE_BENCHMARK") != "1" or name not in {"video-1080p-120s.mp4", "video-4k-60s.mp4"}:
        raise HTTPException(404, "Benchmark fixture unavailable")
    path = STATE / "fixtures" / name
    if not path.exists():
        raise HTTPException(404, "Run prepare_fixtures.py first")
    return FileResponse(path, media_type="video/mp4")


class BenchmarkResult(BaseModel):
    fixture: str
    browser_version: str
    runs: list[dict] = Field(max_length=12)
    metrics: dict | None = None


@app.post("/benchmark/results")
async def benchmark_result(report: BenchmarkResult):
    if os.getenv("OPENCUT_NATIVE_BENCHMARK") != "1":
        raise HTTPException(404, "Benchmark mode is disabled")
    if report.fixture not in {"video-1080p-120s.mp4", "video-4k-60s.mp4", "proxy-720p-60s", "playback-31m"}:
        raise HTTPException(422, "Unknown fixture")
    folder = STATE / "browser-benchmarks"
    folder.mkdir(exist_ok=True)
    required = sum(assets[run["asset_id"]]["path"].stat().st_size for run in report.runs if run.get("asset_id") in assets)
    if disk_usage() + required > LIMIT:
        raise HTTPException(413, "Benchmark outputs exceed the native storage quota")
    records = []
    for run in report.runs:
        asset_id = run.get("asset_id")
        if asset_id not in assets:
            raise HTTPException(422, "Unknown benchmark output asset")
        path = folder / f"{asset_id}.mp4"
        shutil.copyfile(assets[asset_id]["path"], path)
        records.append({**run, "output": path.name, "metadata": assets[asset_id]["metadata"]})
    target = folder / f"{report.fixture}.json"
    target.write_text(json.dumps({**report.model_dump(), "runs": records}, indent=2))
    return {"saved": target.name}
