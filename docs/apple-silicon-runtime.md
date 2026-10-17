# Native developer launcher

Use native ARM64 macOS with Docker Desktop running. Install native `uv`, Bun 1.2.18, native Node.js compatible with Next 16 (tested Node 22), Ollama, FFmpeg and ffprobe with VideoToolbox. From the repository root:

```sh
./scripts/mac.sh doctor
./scripts/mac.sh setup
./scripts/mac.sh start
./scripts/mac.sh status
./scripts/mac.sh stop
```

Open http://127.0.0.1:3000. `start` builds and runs the optimized production website in `.next-production`. Use `start --dev` explicitly for hot-reloading development; `.next` remains separate. Production startup rebuilds before opening the web listener, and rolls back owned services if the build fails. Setup uses managed ARM64 Python 3.11, separate service virtual environments and committed native dependency locks. It preserves existing environment files. Database/Redis infrastructure runs in the isolated `opencut-mac` Docker project; AI workers, backend, web and a private Ollama instance run natively. Setup/start accept `--with-turboquant` for the optional service.

Listeners bind to loopback. Ports: web 3000, backend 8420, workers 8421–8427, optional media 8428, optional TurboQuant 8430, owned Ollama proxy 11435/upstream 11436, database 5432, Redis 6380 and Redis HTTP 8079. Existing Ollama on 11434 is left alone. Incompatible executables, missing dependencies, occupied ports and failed health checks prevent startup. Logs/state/models are in ignored `.mac-runtime`.

Stop verifies recorded process identity and only terminates launcher-owned processes and descendants. It stops this Docker project without removing persistent volumes. The old image-only entry point delegates to the supervisor.

This launcher is the first part of a draft Apple Silicon stack. Subsequent PRs add MLX transcription, cross-process memory coordination, native media jobs and measured validation. Read `docs/apple-silicon.md` in the completed stack before enabling experimental acceleration. Desktop packaging is not included.

The native profile overrides connection URLs in process memory to use its own local PostgreSQL/Redis and site origin. Environment files stay intact. A fresh managed PostgreSQL database receives the repository schema; an unknown or changed existing schema requires a reviewed migration instead of an automatic schema push. Project serialization formats are unchanged.


## Protecting local editing projects

Projects and imported originals are kept in this browser profile, using IndexedDB and origin-private storage. Use the same browser and `http://127.0.0.1:3000` each time: `localhost`, a different port, or another browser has separate storage. Database Docker volumes do not contain these browser-local projects. Clearing site data or deleting the profile removes local projects/media.

In editor Settings, choose **Download project backup**. Keep the `.ocbackup` file on disk outside browser storage. It includes current timeline/settings and original imported media, with SHA-256 checks of the manifest and each 8 MiB media chunk. Proxies, decoded caches, version-control history and API keys are excluded. The current archive format supports projects up to 8 GiB of original media with a 16 MiB manifest; larger projects need a future streaming archive implementation. Do not clear browser data until you have verified a restore.

Choose **Restore project backup** in Settings or the Projects page, select the downloaded archive, and wait for a new `(restored)` project. The entire archive is validated before storage writes, media is written before project registration, and incomplete restores attempt to remove their staged media. Restore uses a fresh project ID and preserves existing projects. Future project versions are rejected rather than loaded unsafely; use the app version that created the backup. A failed restore leaves its source archive unchanged.

A project can be edited in one tab at a time. A second tab displays a retry screen; close the first editor, then retry. Browser Web Locks release ownership when the tab closes or crashes. Saves and media mutations respect ownership, including operations launched from the Projects page. Use a desktop browser with Web Locks support; the app refuses unsafe concurrent editing when locking is unavailable.


If an original file disappears from browser storage, project loading now stops and lists the missing names and byte counts. Choose **Reconnect original files** and select those originals; matching files are copied into the existing media IDs, preserving timeline edits. Filename and size are matching checks, not a content-authenticity guarantee: select your actual original files. If metadata is missing too, restore a project backup. Invalid project URLs offer retry, backup restore, and return to Projects without creating replacement projects.


For reproducible audio timing checks, generate a nonperiodic fixture with `python scripts/mac/prepare_audio_markers.py --output /tmp/stereo-markers-4s.wav` (NumPy required). Import it in a new project, add it to an audio track, split at 00:00:02:00, and export MP4 with audio enabled. Run `python scripts/mac/validate_audio.py --reference /tmp/stereo-markers-4s.wav --encoded /path/to/export.mp4 --markers 0.25 1.25 1.99 2.5 3.75 --report /tmp/audio-report.json`. It preserves presentation timestamps, checks both channels, and fails for missing/weak matches or offsets beyond 20ms. Raw PCM decoded without the initial presentation offset can give false timing diagnoses; periodic tones alone cannot establish alignment.

Export Cancel stops pending work and shows **Cancelling…** until cleanup finishes. Closing the export popup also requests cancellation; reopening it keeps the pending job visible and prevents overlapping exports. Browser audio decode/offline rendering cannot be interrupted mid-call, so those stages finish before ownership is released. After cancellation, export options are available for retry and no result is downloaded.

Project deletion requires typing the exact text `DELETE`. The app waits for an active autosave before deleting and clears queued save work to prevent resurrection. Deletion is permanent: create and verify a portable backup first. Failed new-project persistence leaves the previous project active so creation can be retried.


## Runtime readiness and recovery

`./scripts/mac.sh status` probes identity-verified processes and actual Docker container health. It returns exit code 0 only when the complete configured stack is healthy; missing/stopped/unhealthy services return 3. Use `./scripts/mac.sh status --json` for automation. Status can run during startup/restart without acquiring the supervisor mutation lock, and does not create a new runtime token. The report includes the recovery command and log directory, never the token.

Use `./scripts/mac.sh restart` after a stopped worker or failed service. It stops only identity-verified launcher-owned processes and the isolated Compose project, then rebuilds and starts the production site. Existing database volumes and browser-local projects remain; it does not delete browser storage. `restart --dev` explicitly uses the development web server. This is explicit recovery, not automatic process respawn. Inspect `.mac-runtime/logs/<service>.log` for the failure cause. Invalid process-state JSON is preserved and rejected rather than guessing which processes to terminate.

Native workers and backend accept browser requests only from the editor origins `http://127.0.0.1:3000` and `http://localhost:3000`, and require a loopback Host header matching the listening port. Unrelated cross-site subresources and WebSocket origins are rejected before model admission. Local server-to-server calls without a browser Origin still work. The media worker retains its separate launcher-token requirement. These checks protect the browser-to-native boundary; they do not authenticate other processes running as the local user. Container entrypoints retain their configured deployment behavior.

Restore validates the whole archive before storage writes and creates a new project only after all originals are stored. A failed write attempts to remove staged media and leaves existing projects intact. If cleanup also fails, the error explicitly reports incomplete restore data; keep the backup and retry after resolving storage access/capacity. A durable restore journal now tracks staged destinations. Loading the project list retries cleanup for abandoned restores, skips a restore still running in another tab, and preserves every published project. Failed cleanup keeps its journal entry and reports an error so it can retry later. Actual browser/process termination during OPFS writes still requires acceptance validation.
