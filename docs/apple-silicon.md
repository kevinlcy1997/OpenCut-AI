# Apple Silicon development

This initial profile accelerates Ollama and image generation on native macOS.
It does not yet replace CPU transcription with MLX. Docker AI services cannot
use the host's Metal GPU. Run the web app and AI backend natively and retain
Docker for infrastructure.

## Setup

Use native ARM64 Python 3.11, Bun, uv, FFmpeg, and the macOS Ollama application.
From the repository root:

```bash
docker compose up -d db redis serverless-redis-http
ollama pull llama3.2:1b
uv venv --python 3.11 services/image-service/.venv
uv pip install --python services/image-service/.venv/bin/python -r services/image-service/requirements.txt
bash scripts/start-mac-image.sh
```

The image service binds to loopback and requires MPS by default. Set
`IMAGE_DEVICE=cpu` to compare CPU performance. The service also accepts `auto`
(CUDA, then MPS, then CPU) and `cuda`; unavailable explicit devices fail rather
than silently falling back. MPS initially uses float32 for compatibility and
attention slicing to reduce memory demand. Model downloads occur on first load.

In a second terminal, install and run the backend in its own environment:

```bash
uv venv --python 3.11 services/ai-backend/.venv
uv pip install --python services/ai-backend/.venv/bin/python -r services/ai-backend/requirements.txt
cd services/ai-backend
OPENCUTAI_HOST=127.0.0.1 OPENCUTAI_AI_LLM_BACKEND=ollama \
OPENCUTAI_OLLAMA_URL=http://localhost:11434 \
OPENCUTAI_IMAGE_SERVICE_URL=http://localhost:8423 \
OPENCUTAI_REDIS_URL=redis://localhost:6380 .venv/bin/python run.py
```

In another terminal, copy `apps/web/.env.example` to `apps/web/.env.local`, set
an appropriate authentication secret, then run `bun install` and `bun dev:web`.
The example already points to the local database and backend. Start Ollama's
macOS app before invoking LLM features. Additional AI features require their
corresponding services; this profile does not start them.

## Verification and remaining work

Check `http://localhost:8423/health`, load a small diffusion model through the
editor, and verify the reported device is `mps`. Compare the same model, prompt,
resolution, seed, and step count on CPU/MPS after a warm-up, recording peak
memory as well as elapsed time. Device-selection tests do not establish model
compatibility or measured acceleration.

Next increments: MLX Whisper with word timestamps and silence handling; native
face/TTS service validation; coordinated model loading to bound unified-memory
usage; and native media encoding benchmarks. No speedup is claimed yet.
