"""Native-only runtime discovery; secrets are returned only to local editor origins."""
import asyncio
import os
from pathlib import Path
import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/native", tags=["native-runtime"])
ORIGINS = {"http://localhost:3000", "http://127.0.0.1:3000"}


def require_native(request):
    if not os.getenv("OPENCUT_MAC_STATE"):
        raise HTTPException(404, "Native runtime is not active")
    if request.headers.get("origin") not in ORIGINS:
        raise HTTPException(403, "Use the local editor origin")


@router.get("/runtime")
async def runtime(request: Request):
    require_native(request)
    return {"media_url": "http://127.0.0.1:8428", "token": os.environ["OPENCUT_MEDIA_TOKEN"]}


@router.get("/status")
async def status(request: Request):
    require_native(request)
    ports = {"whisper": 8421, "tts": 8422, "image": 8423, "speaker": 8424,
             "face": 8425, "clip": 8426, "translate": 8427, "ollama": 11435}
    async with httpx.AsyncClient(timeout=3) as client:
        async def health(name, port):
            try:
                response = await client.get(f"http://127.0.0.1:{port}/health")
                response.raise_for_status()
                value = response.json()
                if name == "image":
                    value["model"] = value.get("models", {}).get("diffusion", {})
                if name == "ollama":
                    value["model"] = {"loaded": bool(value.get("loaded_models")), "backend": "ollama", "device": value.get("device"),
                                      "name": ", ".join(model["name"] for model in value.get("loaded_models", []))}
                model = value.get("model")
                if isinstance(model, dict):
                    model["name"] = model.get("name") or model.get("model_name") or model.get("model_size")
                    model["device"] = model.get("device") or value.get("device")
                return name, value
            except (httpx.HTTPError, ValueError):
                return name, {"status": "unavailable"}
        services = dict(await asyncio.gather(*(health(n, p) for n, p in ports.items())))
        try:
            response = await client.get("http://127.0.0.1:11435/native/status")
            response.raise_for_status()
            coordination = response.json()
        except (httpx.HTTPError, ValueError):
            coordination = {"status": "unavailable"}
    return {"services": services, "coordination": coordination}


class WhisperBackend(BaseModel):
    backend: str


class CancelTicket(BaseModel):
    ticket_id: str


@router.post("/cancel")
async def cancel(request: Request, value: CancelTicket):
    require_native(request)
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post("http://127.0.0.1:11435/native/cancel", json=value.model_dump(),
                                     headers={"X-OpenCut-Internal": os.environ["OPENCUT_MEDIA_TOKEN"]})
        if response.is_error:
            raise HTTPException(response.status_code, response.text)
        return response.json()


@router.post("/whisper/backend")
async def backend(request: Request, value: WhisperBackend):
    require_native(request)
    if value.backend not in {"auto", "mlx", "faster-whisper"}:
        raise HTTPException(422, "Unknown Whisper backend")
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post("http://127.0.0.1:8421/backend", params={"backend": value.backend})
        if response.is_error:
            raise HTTPException(response.status_code, response.text)
        return response.json()


class ImageDevice(BaseModel):
    device: str


@router.post("/image/device")
async def image_device(request: Request, value: ImageDevice):
    require_native(request)
    if value.device not in {"auto", "cpu", "mps", "cuda"}:
        raise HTTPException(422, "Unknown image device")
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post("http://127.0.0.1:8423/backend", params={"device": value.device})
        if response.is_error:
            raise HTTPException(response.status_code, response.text)
        return response.json()
