"""Native Ollama adapter participating in the same cross-process lease."""
import asyncio
import importlib.util
from contextlib import asynccontextmanager
import os
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
COORDINATED = importlib.util.find_spec("coordinator") is not None
if COORDINATED:
    from coordinator import NativeGuard, idle_reaper
UPSTREAM = os.getenv("OPENCUT_OLLAMA_UPSTREAM", "http://127.0.0.1:11436")


@asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(idle_reaper(os.environ["OPENCUT_MAC_STATE"])) if COORDINATED else None
    yield
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(lifespan=lifespan)
if COORDINATED:
    app.add_middleware(NativeGuard)


@app.get("/health")
async def health():
    async with httpx.AsyncClient(timeout=5) as client:
        response = await client.get(f"{UPSTREAM}/api/ps")
        response.raise_for_status()
    models = response.json().get("models", [])
    return {"status": "ok", "backend": "ollama", "device": "metal" if any(model.get("size_vram", 0) for model in models) else "cpu" if models else None,
            "loaded_models": models}


@app.post("/unload")
async def unload():
    async with httpx.AsyncClient(timeout=30) as client:
        result = await client.get(f"{UPSTREAM}/api/ps")
        result.raise_for_status()
        for model in result.json().get("models", []):
            response = await client.post(f"{UPSTREAM}/api/generate", json={"model": model["name"], "keep_alive": 0})
            response.raise_for_status()
    return {"status": "unloaded"}


@app.api_route("/{path:path}", methods=["GET", "POST", "DELETE"])
async def proxy(path: str, request: Request):
    client = httpx.AsyncClient(timeout=600)
    try:
        outgoing = client.build_request(request.method, f"{UPSTREAM}/{path}",
                                        content=await request.body(), params=request.query_params,
                                        headers={"content-type": request.headers.get("content-type", "application/json")})
        response = await client.send(outgoing, stream=True)
    except BaseException:
        await client.aclose()
        raise

    async def body():
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()
    return StreamingResponse(body(), status_code=response.status_code, media_type=response.headers.get("content-type"))
