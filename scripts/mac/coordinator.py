"""Cross-process native AI lease; file locks are released by the OS on crashes."""
import asyncio
import fcntl
import json
import sys
import os
import re
from pathlib import Path
import time
import uuid

import httpx
import psutil
from starlette.requests import Request
from starlette.responses import JSONResponse

DEFAULT_ESTIMATES = {"whisper-service": 1024, "image-service": 8192, "tts-service": 3072,
                     "speaker-service": 2048, "clip-service": 1024, "translate-service": 3072,
                     "face-service": 512, "ollama-proxy": 2048, "turboquant-service": 4096}
PORTS = {"whisper-service": 8421, "image-service": 8423, "tts-service": 8422,
         "speaker-service": 8424, "clip-service": 8426, "translate-service": 8427,
         "face-service": 8425, "ollama-proxy": 11435, "turboquant-service": 8430}


def memory_capacity(total_mb, available_mb):
    # Carve 4GiB out of the total AI budget. OS/editing memory already in use
    # must not be reserved twice; retain 1GiB free for interactive bursts.
    return max(0, min(total_mb - 4096, available_mb - 1024))


def estimate(service, model):
    if service == "whisper-service":
        return {"tiny": 512, "base": 1024, "small": 2048, "medium": 4096, "large-v3": 8192}.get(model)
    if service == "image-service":
        known = {"segmind-tiny": 4096, "segmind/tiny-sd": 4096, "small-sd": 4096, "OFA-Sys/small-stable-diffusion-v0": 4096,
                 "sd-1.5": 6144, "runwayml/stable-diffusion-v1-5": 6144,
                 "stable-diffusion-2-1": 8192, "stabilityai/stable-diffusion-2-1": 8192,
                 "sdxl-turbo": 24576, "stabilityai/sdxl-turbo": 24576,
                 "sdxl-base": 24576, "stabilityai/stable-diffusion-xl-base-1.0": 24576,
                 "flux-schnell": 49152, "black-forest-labs/FLUX.1-schnell": 49152}
        return known.get(model)
    if service == "translate-service":
        return {"facebook/nllb-200-distilled-600M": 3072, "facebook/nllb-200-distilled-1.3B": 6144,
                "facebook/nllb-200-3.3B": 16384}.get(model)
    if service == "tts-service":
        short = model.rsplit("/", 1)[-1]
        return {"xtts_v2": 4096, "your_tts": 2048, "kitten_tts": 2048, "fast_pitch": 2048,
                "vits-en": 1024, "vits-en-multi": 1024, "vits": 1024, "tacotron2-en": 1024,
                "tacotron2-DDC": 1024}.get(short)
    if service == "clip-service":
        return {"ViT-B-32": 1024, "ViT-L-14": 4096, "ViT-H-14": 8192, "ViT-bigG-14": 16384}.get(model)
    if service == "turboquant-service":
        return {"Qwen/Qwen2.5-0.5B-Instruct": 4096, "Qwen/Qwen2.5-1.5B-Instruct": 8192,
                "Qwen/Qwen2.5-3B-Instruct": 16384, "Qwen/Qwen2.5-7B-Instruct": 36864}.get(model)
    return DEFAULT_ESTIMATES.get(service)


def write_ticket(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


class Lease:
    def __init__(self, state, service, required_mb):
        self.state = Path(state)
        self.service = service
        self.required_mb = required_mb
        self.lock = None
        self.ticket = None
        self.acquired = False
        self.requested_model = None

    def status(self):
        path = self.state / "lease.json"
        value = json.loads(path.read_text()) if path.exists() else {}
        value["queued"] = max(0, len(list((self.state / "queue").glob("*.json"))) - int(bool(value.get("busy"))))
        value["queue_entries"] = []
        for ticket in sorted((self.state / "queue").glob("*.json")):
            try:
                item = json.loads(ticket.read_text())
                if not item.get("active") and not item.get("cancelled"):
                    value["queue_entries"].append({"id": ticket.name, "service": item.get("service"), "model": item.get("model")})
            except (OSError, ValueError):
                pass
        value["reserved_mb"] = 4096
        value["estimate_kind"] = "estimated working memory, not measured allocation"
        try:
            value["measured_process_rss_mb"] = psutil.Process(value["pid"]).memory_info().rss / 1048576
        except (KeyError, psutil.Error):
            value["measured_process_rss_mb"] = None
        return value

    def write(self, value):
        temp = self.state / f"lease-{os.getpid()}.tmp"
        temp.write_text(json.dumps(value))
        temp.replace(self.state / "lease.json")

    async def acquire(self, timeout=300):
        self.state.mkdir(parents=True, exist_ok=True)
        queue = self.state / "queue"
        queue.mkdir(exist_ok=True)
        with (self.state / "queue.lock").open("a+") as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            for ticket in queue.glob("*.json"):
                try:
                    if not psutil.pid_exists(json.loads(ticket.read_text())["pid"]):
                        ticket.unlink(missing_ok=True)
                except (OSError, ValueError, KeyError):
                    ticket.unlink(missing_ok=True)
            if len(list(queue.glob("*.json"))) >= 8:
                raise RuntimeError("Native AI queue is full; retry after a job completes")
            self.ticket = queue / f"{time.time_ns():020d}-{uuid.uuid4().hex}.json"
            write_ticket(self.ticket, {"pid": os.getpid(), "service": self.service, "model": self.requested_model})
        self.lock = (self.state / "ai.lock").open("a+")
        deadline = time.monotonic() + timeout
        try:
            while True:
                if json.loads(self.ticket.read_text()).get("cancelled"):
                    raise RuntimeError("Queued AI operation cancelled")
                try:
                    # A holder can crash after this waiter joined the queue.
                    # Remove its abandoned ticket so FIFO does not stall forever.
                    with (self.state / "queue.lock").open("a+") as guard:
                        fcntl.flock(guard, fcntl.LOCK_EX)
                        for ticket in queue.glob("*.json"):
                            try:
                                abandoned = not psutil.pid_exists(json.loads(ticket.read_text())["pid"])
                            except (OSError, ValueError, KeyError):
                                abandoned = True
                            if abandoned:
                                ticket.unlink(missing_ok=True)
                    if self.ticket != sorted(queue.glob("*.json"))[0]:
                        raise BlockingIOError()
                    fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.acquired = True
                    with (self.state / "queue.lock").open("a+") as guard:
                        fcntl.flock(guard, fcntl.LOCK_EX)
                        item = json.loads(self.ticket.read_text())
                        if item.get("cancelled"):
                            raise RuntimeError("Queued AI operation cancelled")
                        item["active"] = True
                        write_ticket(self.ticket, item)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Native AI queue wait exceeded five minutes")
                    await asyncio.sleep(.05)
            previous = self.status()
            switching_model = self.requested_model and previous.get("model") and self.requested_model != previous["model"]
            if previous.get("service") and (previous["service"] != self.service or switching_model):
                await self.unload(previous["service"])
            memory = psutil.virtual_memory()
            capacity = memory_capacity(memory.total / 1048576, memory.available / 1048576)
            # Estimates include this worker's existing runtime/model working set.
            resident = psutil.Process().memory_info().rss / 1048576
            if self.service == "ollama-proxy" and previous.get("service") == self.service and not switching_model:
                resident += previous.get("estimated_mb", 0)
            capacity = min(memory.total / 1048576 - 4096, capacity + resident)
            if self.required_mb > capacity:
                raise MemoryError(f"Model needs an estimated {self.required_mb}MB; capacity is {int(capacity)}MB with a 4GB system budget and 1GB free headroom. Select a smaller model or context.")
            self.write({"service": self.service, "pid": os.getpid(), "busy": True,
                        "estimated_mb": self.required_mb, "updated": time.time()})
        except BaseException:
            self.release()
            raise

    async def unload(self, service):
        if service not in PORTS:
            raise RuntimeError(f"Cannot safely unload unknown service {service}")
        headers = {"X-OpenCut-Internal": os.environ["OPENCUT_MEDIA_TOKEN"]}
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                path = "/v1/models/unload" if service == "turboquant-service" else "/unload"
                response = await client.post(f"http://127.0.0.1:{PORTS[service]}{path}", headers=headers)
                response.raise_for_status()
        except httpx.ConnectError:
            # A terminated worker cannot retain model memory.
            return
        except httpx.HTTPError as error:
            raise RuntimeError(f"Could not unload {service}; refusing a second heavy model") from error

    def release(self):
        if self.lock:
            # Update only after acquisition, never overwrite another holder's status.
            current = self.status()
            if self.acquired and current.get("pid") == os.getpid() and current.get("service") == self.service:
                current.update(busy=False, updated=time.time())
                self.write(current)
            fcntl.flock(self.lock, fcntl.LOCK_UN)
            self.lock.close()
            self.lock = None
            self.acquired = False
        if self.ticket:
            self.ticket.unlink(missing_ok=True)


class NativeGuard:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request = Request(scope, receive)
        try:
            response, lease = await self.admit(request)
        except (ValueError, AttributeError):
            return await JSONResponse({"detail": "Invalid admission request"}, status_code=422)(scope, receive, send)
        if response is not None:
            return await response(scope, receive, send)
        if lease is None:
            return await self.app(scope, receive, send)
        # Small JSON admission bodies were consumed; replay them for the route.
        if hasattr(request, "_body"):
            replayed = False
            original_receive = receive
            async def replay():
                nonlocal replayed
                if not replayed:
                    replayed = True
                    return {"type": "http.request", "body": request._body, "more_body": False}
                return await original_receive()
            receive = replay
        worker = asyncio.create_task(self.app(scope, receive, send))
        cancelled = False
        try:
            # Keep ownership even if the caller cancels repeatedly during inference.
            while True:
                try:
                    await asyncio.shield(worker)
                    break
                except asyncio.CancelledError:
                    cancelled = True
                    if worker.done():
                        break
            if cancelled:
                raise asyncio.CancelledError()
        finally:
            if request.url.path in {"/unload", "/backend", "/v1/models/unload"}:
                lease.write({"busy": False, "updated": time.time()})
            lease.release()

    async def admit(self, request):
        state = os.environ["OPENCUT_MAC_STATE"]
        service = os.environ["OPENCUT_MAC_SERVICE"]
        lease = Lease(state, service, DEFAULT_ESTIMATES.get(service, 1024))
        if request.url.path == "/native/status":
            return JSONResponse(lease.status()), None
        internal = request.headers.get("X-OpenCut-Internal") == os.environ["OPENCUT_MEDIA_TOKEN"]
        if request.url.path == "/native/cancel":
            if not internal:
                return JSONResponse({"detail": "Runtime token required"}, status_code=403), None
            identifier = (await request.json()).get("ticket_id", "")
            if not isinstance(identifier, str) or not re.fullmatch(r"\d{20}-[a-f0-9]{32}\.json", identifier):
                return JSONResponse({"detail": "Invalid queue ticket"}, status_code=422), None
            queue = Path(state) / "queue"
            with (Path(state) / "queue.lock").open("a+") as guard:
                fcntl.flock(guard, fcntl.LOCK_EX)
                ticket = queue / identifier
                try:
                    item = json.loads(ticket.read_text())
                except (OSError, ValueError):
                    return JSONResponse({"detail": "Queue ticket no longer exists"}, status_code=404), None
                if item.get("active"):
                    return JSONResponse({"detail": "Active inference must finish before memory is released"}, status_code=409), None
                item["cancelled"] = True
                write_ticket(ticket, item)
            return JSONResponse({"cancelled": True}), None
        heavy = request.method in {"POST", "DELETE"} and not internal and request.url.path != "/remove-bg-video"
        if not heavy:
            return None, None
        model = request.query_params.get("model_size") or request.query_params.get("model_name")
        if request.url.path in {"/load", "/v1/models/load"} and request.headers.get("content-type", "").startswith("application/json"):
            body = await request.json()
            model = body.get("model_name") or body.get("model_size") or body.get("model_id") or model
        defaults = {"whisper-service": os.getenv("WHISPER_MODEL_SIZE", "base"),
                    "image-service": os.getenv("DIFFUSION_MODEL", "stabilityai/stable-diffusion-2-1"),
                    "tts-service": os.getenv("TTS_MODEL", "xtts_v2"),
                    "translate-service": os.getenv("NLLB_MODEL", "facebook/nllb-200-distilled-600M"),
                    "clip-service": os.getenv("CLIP_MODEL_NAME", "ViT-B-32"),
                    "turboquant-service": os.getenv("MODEL_NAME", "Qwen/Qwen2.5-0.5B-Instruct")}
        if service in defaults and request.url.path not in {"/unload", "/backend", "/v1/models/unload"}:
            if not model:
                selections = Path(state) / "selections.json"
                if selections.exists():
                    model = json.loads(selections.read_text()).get(service)
            model = model or defaults[service]
            required = estimate(service, model)
            if required is None:
                return JSONResponse({"detail": "No validated memory estimate for this model; use a supported model"}, status_code=422), None
            lease.required_mb = required
            if service == "image-service" and getattr(sys.modules.get("app"), "IMAGE_DEVICE", os.getenv("IMAGE_DEVICE")) == "cpu":
                lease.required_mb = int(required * 1.5)
        if request.url.path in {"/unload", "/backend", "/v1/models/unload"}:
            lease.required_mb = 0
        if service == "ollama-proxy" and request.method in {"POST", "DELETE"} and request.url.path != "/unload":
            try:
                body = await request.json()
                model = body.get("model")
                if model:
                    async with httpx.AsyncClient(timeout=10) as client:
                        upstream = os.getenv("OPENCUT_OLLAMA_UPSTREAM", "http://127.0.0.1:11436")
                        tags = await client.get(f"{upstream}/api/tags")
                        tags.raise_for_status()
                    name = model if ":" in model else f"{model}:latest"
                    selected = next((entry for entry in tags.json().get("models", []) if entry["name"] == name), None)
                    if selected:
                        async with httpx.AsyncClient(timeout=10) as client:
                            details = await client.post(f"{upstream}/api/show", json={"model": name})
                            details.raise_for_status()
                        info = details.json().get("model_info", {})
                        architecture = info.get("general.architecture", "llama")
                        blocks = info.get(f"{architecture}.block_count", 64)
                        embedding = info.get(f"{architecture}.embedding_length", 8192)
                        heads = info.get(f"{architecture}.attention.head_count", 64)
                        kv_heads = info.get(f"{architecture}.attention.head_count_kv", heads)
                        context = max(1, int(body.get("options", {}).get("num_ctx", 2048)))
                        kv_mb = context * blocks * (embedding / max(1, heads)) * kv_heads * 8 / 1048576
                        lease.required_mb = int(selected["size"] / 1048576 * 1.25 + kv_mb + 512)
                    elif request.url.path in {"/api/generate", "/api/chat", "/api/embed", "/api/embeddings"}:
                        return JSONResponse({"detail": "Download the selected Ollama model before inference"}, status_code=422), None
            except (ValueError, httpx.HTTPError):
                return JSONResponse({"detail": "Cannot estimate the selected Ollama model"}, status_code=503), None
        if service == "ollama-proxy" and request.url.path in {"/api/pull", "/unload"}:
            lease.required_mb = 0
        try:
            lease.requested_model = model
            await lease.acquire()
            status = lease.status()
            status["model"] = model
            lease.write(status)
            if model and service in defaults and request.url.path not in {"/unload", "/backend", "/v1/models/unload"}:
                selections = Path(state) / "selections.json"
                selected = json.loads(selections.read_text()) if selections.exists() else {}
                selected[service] = model
                temporary = selections.with_suffix(".tmp")
                temporary.write_text(json.dumps(selected))
                temporary.replace(selections)
                # Keep the user's model choice when the previous service unloaded it.
                setting = {"whisper-service": "WHISPER_MODEL_SIZE", "image-service": "DIFFUSION_MODEL",
                           "tts-service": "TTS_MODEL", "translate-service": "NLLB_MODEL",
                           "clip-service": "MODEL_NAME", "turboquant-service": "MODEL_NAME"}[service]
                module = sys.modules.get("app")
                if module is not None:
                    setattr(module, setting, model)
        except MemoryError as error:
            return JSONResponse({"detail": str(error)}, status_code=507), None
        except RuntimeError as error:
            return JSONResponse({"detail": str(error)}, status_code=503), None
        return None, lease


async def idle_reaper(state):
    while True:
        await asyncio.sleep(15)
        lease = Lease(state, "idle", 0)
        lock = (Path(state) / "ai.lock").open("a+")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            status = lease.status()
            if status.get("service") and time.time() - status.get("updated", 0) >= 300:
                await lease.unload(status["service"])
                lease.write({"busy": False, "updated": time.time()})
        except (BlockingIOError, RuntimeError):
            pass
        finally:
            lock.close()
