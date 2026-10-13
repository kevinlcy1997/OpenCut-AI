# Native Apple Silicon developer runtime

This is an experimental developer release for native ARM64 macOS, initially measured on an M4 MacBook Pro (Mac16,1, 16GB). Desktop packaging is not included. Linux CPU/CUDA and Docker entry points keep their existing dependency files and behavior.

## Start

Install native ARM64 `uv`, Bun 1.2.18, native Node.js compatible with Next 16 (tested Node 22), FFmpeg/ffprobe with VideoToolbox, Docker Desktop with Compose, and Ollama. Do not use Intel/Rosetta executables. Start Docker Desktop, then run from the repository root:

```sh
./scripts/mac.sh doctor
./scripts/mac.sh setup
./scripts/mac.sh start
./scripts/mac.sh status
./scripts/mac.sh stop
```

Open http://127.0.0.1:3000. Setup installs Python 3.11 into `.mac-runtime/python`, creates an isolated `.venv` per service, syncs native locks, and installs the frozen Bun dependencies. Existing environment files are preserved. Model downloads happen on first use. `setup --with-turboquant` and `start --with-turboquant` include the optional TurboQuant service; Ollama remains the default provider.

Only PostgreSQL, Redis and Redis HTTP run in the isolated `opencut-mac` Docker project. The launcher uses private Ollama ports 11436 (upstream) and 11435 (coordinated proxy), leaving an existing Ollama instance on 11434 alone. Web uses 3000, backend 8420, AI workers 8421–8427, media 8428, optional TurboQuant 8430, database 5432, Redis 6380 and Redis HTTP 8079. Native listeners bind to loopback. Occupied ports, missing dependencies, incompatible executables and failed health checks stop startup with an explanation. Logs are in `.mac-runtime/logs`.

`stop` verifies process identity before terminating launcher-owned processes and descendants. It stops this Docker project without deleting its volumes. Do not manually reuse its ports while it is running. `.mac-runtime` contains model caches, logs and a private token and must not be committed.

## AI selection and memory

The local editor's Settings panel displays native service health, actual backend/device, loaded models, the active job, queue length, estimated working memory and process RSS. RSS does not measure total Metal allocation. Backend/device controls unload the current model before changing configuration.

Whisper supports `WHISPER_BACKEND=auto|mlx|faster-whisper`. `auto` selects installed MLX on native Apple Silicon and faster-whisper elsewhere. Explicit unavailable MLX requests fail; automatic fallback reports its actual backend and reason. Language, duration, segments, confidence and word timestamp fields retain the existing response contract. Silero VAD compacts speech before MLX and restores timestamps to the original recording, including silence. Model size does not change automatically.

Unquantized float32 MLX weights are the conservative default. A version-, OS- and hardware-specific validated profile enables unquantized float16 for the base model on Mac16,1/macOS 27; other models/devices remain float32. `WHISPER_MLX_PRECISION=float32` overrides it. The AMI two-speaker comparison met the relative WER and word-boundary thresholds; this is not a universal accuracy guarantee.

Image MPS uses float32 and attention slicing. Float16 is blocked because the measured Tiny SD model generated non-finite latents and black images. `IMAGE_DEVICE=cpu` and `WHISPER_BACKEND=faster-whisper` can be set before startup. Benchmark-only `OPENCUT_BENCHMARK_UNVALIDATED=1` permits testing rejected image precision; do not use it for normal editing.

One heavy AI operation holds a cross-process lease. The FIFO queue accepts eight tickets including the active operation, waits at most five minutes, drops cancelled/dead tickets, and never unloads a running model. Switching services unloads the previous model; selected model names persist separately from loaded state. Idle models unload after five minutes and release MLX/MPS/CUDA caches where applicable. An interrupted caller waits for synchronous inference to finish before releasing ownership; this avoids overlapping model memory but does not promise immediate interruption of every model kernel.

Admission reserves 4GB of total memory for the OS/editor and retains 1GB of measured free headroom. Estimates are conservative, model-specific admission values, not measured allocations. Unknown/oversized selections are rejected with a request to choose a supported smaller model or context; the service never silently substitutes one. A crashed worker releases its OS lease and cannot stall the remaining queue. Status reports the stopped service; use stop/start to restore its process. Automatic process respawning is not included. Current memory pressure can reject a model on a 16GB machine even if it works in isolation. Ollama estimates include model size and context cache. Keep contexts small on 16GB machines.

Face detection uses native ARM64 CPU MediaPipe. CLIP and translation retain their existing MPS paths. TTS and diarization keep CPU execution until their individual MPS compatibility/quality checks pass. XTTS license acceptance and gated diarization credentials are user actions; setup does not accept terms or provide credentials on your behalf. See the benchmark report for outstanding validation.

## Playback and media jobs

Browser export capability-tests hardware encoder preference, keeps frame submission sequential, reuses effect canvases, profiles decode/copy/effect/encode submission separately, and disposes its own decoder inputs after export. Preview and export decoder caches are independent. Original media remains the export source; the existing proxy cache and cancellation flow remain in place, with 720p defaults for 4K footage.

The native media worker supports opaque asset uploads, asynchronous job status/progress, cancellation, downloads and deletion. It tests VideoToolbox with a real hardware encode; software fallback is prohibited in native jobs. Playlist/network input formats are rejected. Files are session-local with a 2GB asset limit, 10GB managed quota, bounded multipart spooling, four queued/running jobs and one encoder job at a time. Completed/abandoned jobs are cleaned up. A launcher-generated token and explicit local origins protect access; browser requests stream through the same-origin Next route.

Temporary audio uploads preserve float32 mixer samples. The automatic source profile is limited to tested 8-bit H.264, 4K SDR/30fps footage. Initial native export supports contiguous cuts, frame-aligned trims, contain scaling and mono/stereo audio mixed by the browser. Effects, transitions, captions, masks, non-default transforms, speed changes, watermarking, HDR, rotated/VFR sources, mismatched frame rates and unsupported audio use browser export. The worker rejects unsupported inputs rather than dropping their features. The export dialog includes an Always use browser override.

Automatic native proxy/export routing is disabled unless the local `.mac-runtime/media-gates.json` records passing parity and at least 1.25× speedup for that route. Do not hand-edit gates. The benchmark validator writes them only with explicit `--enable-gate`; failed measurements stay disabled. Before broad rollout, also validate cuts/trims and the intended source formats beyond the initial fixture.

## Reproduce measurements

Use the native Whisper environment for speech and the image environment for images. Public fixtures are downloaded and derived reproducibly; their source/license URLs and hashes are recorded in the generated manifest. Keep fixture binaries and model caches local.

```sh
services/whisper-service/.venv/bin/python scripts/mac/prepare_fixtures.py --directory .mac-runtime/fixtures
services/whisper-service/.venv/bin/python scripts/mac/benchmark.py --help
services/image-service/.venv/bin/python scripts/mac/benchmark_image.py --help
services/ai-backend/.venv/bin/python scripts/mac/benchmark_llm.py --model qwen2.5:0.5b --output .mac-runtime/llm.json
```

For browser/native export and proxy measurements, start with `OPENCUT_NATIVE_BENCHMARK=1 ./scripts/mac.sh start`, open http://127.0.0.1:3000/mac-benchmark and run the fixed export and proxy suites separately. Each records one cold and three warm runs. Then:

```sh
services/whisper-service/.venv/bin/python scripts/mac/validate_media.py --output .mac-runtime/media-parity.json
services/ai-backend/.venv/bin/python scripts/mac/soak.py --speech .mac-runtime/fixtures/speech-two-speakers-600s.wav --video .mac-runtime/fixtures/video-4k-60s.mp4 --minutes 30 --output .mac-runtime/soak.json
```

Use the playback-soak button concurrently to exercise a 31-minute effects timeline while the native soak runs. This automated loop does not replace human editing workflows. Blocked operations are not passes. Compare cold startup separately from warm execution and run performance suites without competing model jobs. Keep rejected quality/performance paths experimental and document every unmet release gate.

The native profile overrides connection URLs in process memory to use its own local PostgreSQL/Redis and site origin. Environment files stay intact. A fresh managed PostgreSQL database receives the repository schema; an unknown or changed existing schema requires a reviewed migration instead of an automatic schema push. Project serialization formats are unchanged.
