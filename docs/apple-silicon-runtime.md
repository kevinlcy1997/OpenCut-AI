# Native developer launcher

Use native ARM64 macOS with Docker Desktop running. Install native `uv`, Bun 1.2.18, native Node.js compatible with Next 16 (tested Node 22), Ollama, FFmpeg and ffprobe with VideoToolbox. From the repository root:

```sh
./scripts/mac.sh doctor
./scripts/mac.sh setup
./scripts/mac.sh start
./scripts/mac.sh status
./scripts/mac.sh stop
```

Open http://127.0.0.1:3000. Setup uses managed ARM64 Python 3.11, separate service virtual environments and committed native dependency locks. It preserves existing environment files. Database/Redis infrastructure runs in the isolated `opencut-mac` Docker project; AI workers, backend, web and a private Ollama instance run natively. Setup/start accept `--with-turboquant` for the optional service.

Listeners bind to loopback. Ports: web 3000, backend 8420, workers 8421–8427, optional media 8428, optional TurboQuant 8430, owned Ollama proxy 11435/upstream 11436, database 5432, Redis 6380 and Redis HTTP 8079. Existing Ollama on 11434 is left alone. Incompatible executables, missing dependencies, occupied ports and failed health checks prevent startup. Logs/state/models are in ignored `.mac-runtime`.

Stop verifies recorded process identity and only terminates launcher-owned processes and descendants. It stops this Docker project without removing persistent volumes. The old image-only entry point delegates to the supervisor.

This launcher is the first part of a draft Apple Silicon stack. Subsequent PRs add MLX transcription, cross-process memory coordination, native media jobs and measured validation. Read `docs/apple-silicon.md` in the completed stack before enabling experimental acceleration. Desktop packaging is not included.

The native profile overrides connection URLs in process memory to use its own local PostgreSQL/Redis and site origin. Environment files stay intact. A fresh managed PostgreSQL database receives the repository schema; an unknown or changed existing schema requires a reviewed migration instead of an automatic schema push. Project serialization formats are unchanged.
