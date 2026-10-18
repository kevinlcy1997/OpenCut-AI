# Apple Silicon benchmark report — 2026-10-13–14

Experimental developer release on Mac16,1 (M4, 10 cores, 16GB), native ARM64 Python 3.11.14, macOS 27.0. The CPU baseline was recorded against upstream `eb8aef9f971648980673b207fc28eb76955883b3` before MLX inference changes. Each timing suite separates model loading and the first execution from a three-run warm median. Results apply to these fixtures/configurations; they are not claims for every M-series device or model.

## Fixtures and licensing

Speech: the first 600 seconds of AMI ES2002a headsets A/B, gated to their manual word annotations with 150ms padding and mixed at half amplitude. Long silence and overlapping speakers remain on the original clock. Word references retain source times. AMI is credited to the AMI Consortium/Idiap/University of Edinburgh, CC BY 4.0: https://groups.inf.ed.ac.uk/ami/download/ . Speech SHA-256: `6c579a1d834e86e4272645181dbf3aca2564c0805ada6364f3aea20163c00a3b`.

Video: Big Buck Bunny, Blender Foundation, CC BY 3.0: https://peach.blender.org/about/ . Derive a two-minute 1080p project with grayscale and a one-minute 4K SDR/30fps project from the 4K source at offset 60 seconds. The measured browser/native export used the same Web Audio stereo mix of the source surround audio (PCM16 native upload). The final temporary upload format preserves float32 mixer samples/gain headroom; its native AAC smoke check passes, while automatic export remains gated pending fresh parity/speed measurements. Proxy comparison has no audio. `prepare_fixtures.py` records source/archive/output hashes and reproducible commands; binaries remain local.

Image: fixed ceramic-teapot prompt, seed 42, Tiny SD, 512×512, 20 steps. LLM: identical Qwen 2.5 0.5B Q4_K_M GGUF digest, seed 42, temperature 0, 128 generated tokens and 2048-token context, comparing Ollama CPU and Metal.

## AI measurements

| Configuration | Model load | Cold execution | Warm median | Peak process RSS | Swap growth |
|---|---:|---:|---:|---:|---:|
| Whisper base / faster-whisper CPU int8 | 6.20s | 17.49s | 17.14s | 738MB | 0MB |
| Whisper base / MLX float32 | 7.22s | 16.46s | 12.78s | 620MB | +1134MB |
| Whisper base / MLX float16, isolated | 2.31s | 7.62s | 6.31s | 749MB | −32MB |
| Tiny SD / CPU float32, slicing | 44.68s | 32.90s | 33.17s | 5681MB | +4162MB |
| Tiny SD / MPS float32, slicing | 6.99s | 23.67s | 17.15s | 3252MB | −96MB |
| Tiny SD / MPS float32, no slicing | 6.58s | 24.71s | 23.66s | 3205MB | +1510MB |

Model-loading times depend on cache/download state and should not be interpreted as acceleration ratios. Swap is host-wide and includes other applications; some exploratory measurements ran under memory pressure. The isolated speech run is the basis for its validated profile. The CPU image baseline paged heavily, so its ratio is a result for this host condition rather than a clean compute-only comparison.

Validated speech achieved **2.71×** warm speedup. CPU WER was 34.89%; MLX float16 WER was 34.77%, a 0.12 percentage-point improvement. Median matched-word boundary error was 54ms against 50ms CPU, below the 100ms gate. The absolute WER remains high on overlapping meeting speech; a relative gate is not a universal accuracy guarantee. Pin the tested unquantized base MLX revision and MLX/Whisper versions before selecting this hardware profile. Float32 MLX achieved only 1.34×.

MPS float32/slicing achieved **1.93×** versus the measured CPU image baseline, below the requested 2× target. Its output was visually valid. Float16 produced non-finite latents and black output, including a float32-VAE diagnostic; it is blocked for normal use. No image float16 performance result is accepted as a quality pass. Additional model-specific image quality validation remains required.

Isolated Ollama warm medians: CPU **17.06s**, Metal **1.90s**, **8.97×** speedup. Owned process-tree RSS peaks were 628MB CPU and 602MB Metal; swap growth −8MB/0MB. Model digest and generated text are recorded. CPU and Metal responses were not identical; this is a speed comparison, not proof of equivalent language quality.

Native service requests passed for CLIP embeddings on MPS and face detection on ARM64 CPU. NLLB 600M was rejected by the memory budget on the loaded host. XTTS model license acceptance and gated pyannote credentials were not provided. Their MPS inference is not enabled. These blocked paths remain release-validation work, not successful checks.

## Startup, editing and media

Three fresh native process starts, with infrastructure images/dependencies cached, measured **13.57s median**. Heavy models stayed unloaded and are measured separately. Final startup also initializes the fresh managed PostgreSQL schema (15 tables), preserves it across a second start, and passes the local auth/session endpoint smoke test. Docker VM memory is excluded from native process-tree RSS.

Browser: Chromium 155 in the Codex in-app browser. Source and browser version are recorded in each raw report.

| Workload | Browser cold / warm median | VideoToolbox cold / warm median | Native speedup |
|---|---:|---:|---:|
| 1080p / 120s grayscale | 31.23s / 30.43s | Ineligible, effects retained in browser | — |
| 4K / 60s ordinary export | 30.40s / 30.23s | 32.58s / 32.06s | 0.94× |
| 4K → 720p / 60s proxy | 9.23s / 9.80s | 16.83s / 17.82s | 0.55× |

The corrected 4K export had 1800 frames in both outputs, equal container duration, SSIM 0.992515 and 20ms audio offset. Effects projects correctly rejected native eligibility. This passes the fixture's frame/duration/audio/visual gate, but fails the >=1.25× speed gate.

Proxy outputs had equal 1800-frame counts and duration, with no audio. SSIM 0.963517 failed the 0.99 comparison threshold, and native speed also failed. Compression/color parity needs further work; increasing speed alone cannot enable it.

**Automatic native export and proxy routes remain disabled.** The browser remains the practical default. Native jobs are experimental, with strict source/timeline rejection and a browser override. Gate records bind to the measured source/output profile, hardware, worker implementation and browser version. Broader cuts/trims/source-format validation is still needed before broad automatic rollout.

Browser profiles separate decode waits, canvas/effect/copy submission and encode submission/finalization. Submission timings do not measure completed GPU execution. Export owns and disposes its decoder cache; preview continues independently. Proxy cache reuse and original-media export remain intact.

## Sustained session

Completed a **31-minute effects preview loop** (48,293 rendered frames) concurrently with **30.2 minutes of native work**: 168 successful transcription/LLM/media operations, zero failed requests, and 56 image operations blocked by memory admission. Swap increased 1065MB from session start; a 27-minute window beginning after initial warm-up measured 665MB additional swap, below 1GB. Owned native process-tree RSS peaks included Ollama 608MB, Whisper 582MB and the media worker/encoder 567MB. The measured preview cadence was about 26fps because the original test scheduler reset its rAF threshold; this is not a maximum editor-throughput measurement. The reproducible harness now keeps an absolute frame schedule. Blocked image operations prevent treating that as acceptance of the full image-inclusive editing/AI workload. Reports distinguish completion from a passed acceptance gate; memory estimates and RSS do not measure all Metal allocation.

## Validation and rollout

The ordered draft PR stack contains native runtime, MLX transcription, memory coordination, media optimization, then this validation/release layer. Keep it draft until the documented blockers are resolved. There is no project migration or desktop package.

Checks cover backend selection, VAD/silence/clock restoration, hardware/weight precision gating, process ownership, environment preservation, model switching and persisted selection, FIFO cancellation/full queue/crash recovery, low-memory rejection, native upload authorization, unsupported timeline fields, encoder cancellation/failure and stale media-gate rejection. 38 Python tests, 107 Bun tests and TypeScript checks passed. A final real native two-cut/trim/scaling smoke check produced 60 frames and 2.000s duration. CPU/CUDA device selection is tested with mocks; actual CUDA inference cannot be validated on this Mac.

Remaining release blockers: the 2× image target, native proxy quality/speed, native export speed, NLLB inference under a fitting memory budget, model-specific TTS/diarization MPS validation, broader CLIP/translation quality comparisons, and full image-inclusive sustained-session acceptance. Do not advertise those targets as achieved.


### Presentation-time audio recheck

The local-production audit found that raw FFmpeg PCM extraction discarded the initial audio presentation offset. The validator now uses `aresample=async=1:first_pts=0`. Rechecking the existing 4K benchmark artifacts measured 0ms browser/native audio offset (previous raw-sample measurement: 20ms). Frame count, duration and SSIM are unchanged; native speedup is still 0.943x, so automatic export remains disabled. These historical artifacts predate subsequent audio mixer changes and do not validate the whole latest export implementation.

A separate current-production test generated deterministic nonperiodic stereo markers, split at two seconds and exported through the normal website. Both channels and all five markers, including the marker crossing the cut, measured 0ms offset. Source/encoded hashes and measurements are in the workspace `outputs/audio-split-alignment.json`. This corrects the earlier inferred ~23ms volume-ramp advance, which was a measurement artifact. Additional codec/sample-rate/speed/effects parity remains pending.


### Linear audio speed-ramp timing fixture

The local production website exported a two-second audio timeline using the deterministic stereo source from `prepare_audio_markers.py`, with linear playback-rate keys `(0s, 1x)` and `(2s, 3x)`. The independent reference maps timeline time to source time as `s=t+t*t/2`. Five source markers map into the output; energy-centroid timing is checked separately on both channels within 100ms windows, with a 20ms timing threshold and less than 1% energy outside those windows. This measures marker timing, not waveform or pitch fidelity.

Run `PYTHONPATH=scripts/mac python -m unittest scripts/mac/test_validate_speed_ramp.py`, then `python scripts/mac/validate_speed_ramp.py --source stereo-markers-4s.wav --encoded ramp-export.mp4 --report ramp-timing.json` with NumPy and FFmpeg available. Regenerate the source with `python scripts/mac/prepare_audio_markers.py --output stereo-markers-4s.wav`. The fixture source SHA is recorded in the report. The project uses one uploaded audio clip at start 0s, duration 2s, trimStart/trimEnd 0, sourceDuration 4s, gain 1, pan 0, and a `playbackRate` number animation channel with linear keys at those times; project rate is 30fps.

The observed MP4 has 60 video frames over 2s. All ten per-channel marker measurements are within 1.055ms. The raw noise-waveform correlation validator was inconclusive due to rate/resampling phase differences and remains recorded as a failure in its own report. No automatic acceleration gate was enabled by this result.


### Mixed-media export smoke fixture

The four-second 320x180/30fps fixture uses the first two seconds of `editor-smoke-8s.mp4` (audio muted), then a solid red 320x180 PNG at 50% centered scale for two seconds. A separate four-second stereo track uses `stereo-tone-4s.wav` at clip gain 0.25, track gain 1 and pan -1. Export through the browser with watermark disabled and audio included. Inspect with `python scripts/mac/validate_mixed_media.py --video editor-smoke-8s.mp4 --tone stereo-tone-4s.wav --encoded mixed-export.mp4 --report mixed-report.json` (NumPy, FFmpeg and FFprobe required).

Acceptance checks require 120 frames at 30fps, duration within one frame of four seconds, still starting exactly at frame 60, expected card bounds within two pixels, red interior/black margins, both source tone frequencies at 25% gain on the left and right/left RMS below 0.001. The RGB MAE threshold of 5/255 for downscaled video is a smoke check, not a perceptual/color parity gate. Source channels are 440Hz/880Hz; the hard-left StereoPanner combines both on the left. Measured results and limitations are in `mixed-media-export-validation.json`. This does not test transitions, captions, masks, effects or audio/video alignment with nonperiodic markers.


### Hold-speed boundary fixture

Generate the six-marker source with `python scripts/mac/prepare_audio_markers.py --hold-boundary --output hold-markers-4s.wav`. It adds a deterministic 30ms noise burst at source 0.99s (extra seed 20261018), crossing the speed step. Source SHA: `8f94da9807603bb118272b09f4afc337bbd50d9621e770841caa7a3b073c7275`.

Use a 2s uploaded-audio element with playbackRate hold keys `(0s, 1x)`, `(1s, 3x)`, `(2s, 3x)`, unit gain/pan 0 and no trims. Independent source mapping is `s=t` before 1s, then `s=1+3*(t-1)`. Export in the browser and run `python scripts/mac/validate_speed_ramp.py --curve hold --markers .25 .99 1.25 1.99 2.5 3.75 --source hold-markers-4s.wav --encoded hold-export.mp4 --report hold-timing.json`. The observed file has 60 frames over 2s and all twelve stereo marker timing measurements within 0.941ms. This does not establish waveform/pitch fidelity or preview alignment.
