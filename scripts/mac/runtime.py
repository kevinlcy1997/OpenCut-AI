"""Native development supervisor. Run: python3 scripts/mac/runtime.py COMMAND."""
import argparse
import fcntl
import json
import os
import platform
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".mac-runtime"
SERVICES = {
    "whisper-service": 8421, "tts-service": 8422, "image-service": 8423,
    "speaker-service": 8424, "face-service": 8425, "clip-service": 8426,
    "translate-service": 8427, "media-service": 8428,
}


def run(args, **kwargs):
    environment = dict(os.environ, UV_CACHE_DIR=str(STATE / "uv-cache"), UV_PYTHON_INSTALL_DIR=str(STATE / "python"))
    return subprocess.run(args, check=True, env=environment, **kwargs)


def executable(name):
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"Missing {name}; install its native ARM64 version and add it to PATH")
    run([path, "-version" if name in {"ffmpeg", "ffprobe"} else "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return path


def preflight():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("Use native ARM64 Python on Apple Silicon macOS")
    for tool in ("uv", "bun", "ffmpeg", "ffprobe", "docker", "ollama"):
        executable(tool)
    run(["docker", "info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def identity(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "stat=,lstart="], capture_output=True, text=True)
    if result.returncode != 0 or not result.stdout.strip():
        return ""
    status, started = result.stdout.strip().split(maxsplit=1)
    return "" if status.startswith("Z") else started


def live(entry):
    return bool(entry.get("identity")) and identity(entry["pid"]) == entry["identity"]


def descendants(pid):
    result = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True, check=True)
    parents = {}
    for line in result.stdout.splitlines():
        child, parent = map(int, line.split())
        parents.setdefault(parent, []).append(child)
    pending, found = [pid], []
    while pending:
        parent = pending.pop()
        for child in parents.get(parent, []):
            found.append({"pid": child, "identity": identity(child)})
            pending.append(child)
    return found


def read_state():
    path = STATE / "processes.json"
    return json.loads(path.read_text()) if path.exists() else {}


def save(entries):
    target = STATE / "processes.json"
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps(entries, indent=2))
    temp.replace(target)


def port_free(port):
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            raise RuntimeError(f"Port {port} is occupied; refusing to replace an existing process")


def wait_health(url, process, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Service exited before {url}; inspect .mac-runtime/logs")
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(0.5)
    raise RuntimeError(f"Health timeout: {url}; inspect .mac-runtime/logs")


def infrastructure():
    # Isolated Compose project: stop never touches the user's other stacks.
    path = STATE / "compose.json"
    path.write_text(json.dumps({"services": {
        "db": {"image": "postgres:17", "ports": ["127.0.0.1:5432:5432"],
               "environment": {"POSTGRES_USER": "opencut", "POSTGRES_PASSWORD": "opencut", "POSTGRES_DB": "opencut"},
               "volumes": ["postgres_data:/var/lib/postgresql/data"],
               "healthcheck": {"test": ["CMD-SHELL", "pg_isready -U opencut"], "interval": "2s", "retries": 30}},
        "redis": {"image": "redis:7-alpine", "ports": ["127.0.0.1:6380:6379"],
                  "healthcheck": {"test": ["CMD", "redis-cli", "ping"], "interval": "2s", "retries": 30}},
        "redis-http": {"image": "hiett/serverless-redis-http:latest", "ports": ["127.0.0.1:8079:80"],
                       "environment": {"SRH_MODE": "env", "SRH_TOKEN": "example_token", "SRH_CONNECTION_STRING": "redis://redis:6379"},
                       "depends_on": {"redis": {"condition": "service_healthy"}}},
    }, "volumes": {"postgres_data": {}}}))
    return ["docker", "compose", "-p", "opencut-mac", "-f", str(path)]


def setup():
    preflight()
    for name in ["ai-backend", *SERVICES]:
        directory = ROOT / "services" / name
        lock = ROOT / "scripts/mac/locks" / f"{name}.lock"
        if not lock.exists():
            raise RuntimeError(f"Missing native lock: {lock}")
        run(["uv", "venv", "--python", "3.11", "--managed-python", str(directory / ".venv")])
        run(["uv", "pip", "sync", "--python", str(directory / ".venv/bin/python"), str(lock)])
    env_path = ROOT / "apps/web/.env.local"
    if not env_path.exists():
        content = (ROOT / "apps/web/.env.example").read_text().replace("your_better_auth_secret", secrets.token_hex(32))
        content = "\n".join(line for line in content.splitlines() if "_here" not in line) + "\n"
        env_path.write_text(content)
    run(["bun", "install", "--frozen-lockfile"], cwd=ROOT)


def stop(entries):
    for name, entry in reversed(list(entries.items())):
        if name == "infrastructure":
            continue
        owned = list(entry.get("children", []))
        if live(entry):
            owned.extend(descendants(entry["pid"]))
            owned.append(entry)
        owned = {process["pid"]: process for process in owned}
        for process in reversed(list(owned.values())):
            if live(process):
                os.kill(process["pid"], signal.SIGTERM)
        deadline = time.monotonic() + 10
        while any(live(process) for process in owned.values()) and time.monotonic() < deadline:
            time.sleep(0.1)
        for process in owned.values():
            if live(process):
                os.kill(process["pid"], signal.SIGKILL)
    if "infrastructure" in entries:
        run(infrastructure() + ["stop"])
    save({})


def start():
    preflight()
    entries = read_state()
    if entries:
        raise RuntimeError("Runtime state exists; use status/stop before starting")
    for port in [3000, 8420, 11435, 11436, *SERVICES.values(), 5432, 6380, 8079]:
        port_free(port)
    for name in ["ai-backend", *SERVICES]:
        if not (ROOT / "services" / name / ".venv/bin/python").exists():
            raise RuntimeError(f"Missing {name} environment; run setup first")
    for path in (STATE / "lease.json",):
        path.unlink(missing_ok=True)
    model = subprocess.run(["sysctl", "-n", "hw.model"], capture_output=True, text=True)
    env = dict(os.environ, OPENCUT_MAC_HARDWARE=model.stdout.strip(), OPENCUTAI_HOST="127.0.0.1", OPENCUTAI_AI_LLM_BACKEND="ollama",
               OPENCUTAI_OLLAMA_URL="http://127.0.0.1:11435", OPENCUTAI_REDIS_URL="redis://127.0.0.1:6380",
               OPENCUT_OLLAMA_UPSTREAM="http://127.0.0.1:11436", OLLAMA_HOST="127.0.0.1:11436",
               OLLAMA_MODELS=str(STATE / "models/ollama"),
               OLLAMA_MAX_LOADED_MODELS="1", OLLAMA_NUM_PARALLEL="1",
               OLLAMA_CONTEXT_LENGTH="2048",
               TTS_AUTOLOAD="false", DEVICE=os.getenv("DEVICE", "auto"),
               WHISPER_BACKEND=os.getenv("WHISPER_BACKEND", "auto"), IMAGE_DEVICE=os.getenv("IMAGE_DEVICE", "auto"),
               OPENCUT_MAC_STATE=str(STATE), OPENCUT_MEDIA_TOKEN=(STATE / "token").read_text().strip(),
               PYTHONPATH=str(ROOT / "scripts/mac"), HF_HOME=str(STATE / "models"),
               TORCH_HOME=str(STATE / "models/torch"), TTS_HOME=str(STATE / "models/tts"),
               XDG_CACHE_HOME=str(STATE / "cache"),
               NEXT_PUBLIC_NATIVE_MEDIA_URL="http://127.0.0.1:8428")
    # Local benchmark endpoints require explicit opt-in and the runtime token.
    env["OPENCUT_NATIVE_BENCHMARK"] = os.getenv("OPENCUT_NATIVE_BENCHMARK", "0")
    for name, port in SERVICES.items():
        setting = name.removesuffix("-service").upper()
        env[f"OPENCUTAI_{setting}_SERVICE_URL"] = f"http://127.0.0.1:{port}"
    logs = STATE / "logs"
    logs.mkdir(exist_ok=True)

    def launch(name, args, cwd, url):
        with (logs / f"{name}.log").open("ab") as log:
            proc = subprocess.Popen(args, cwd=cwd, env=dict(env, OPENCUT_MAC_SERVICE=name), stdout=log, stderr=log, start_new_session=True)
        time.sleep(0.05)
        entries[name] = {"pid": proc.pid, "identity": identity(proc.pid), "health": url}
        save(entries)
        wait_health(url, proc)
        entries[name]["children"] = descendants(proc.pid)
        save(entries)

    try:
        entries["infrastructure"] = {"project": "opencut-mac"}
        save(entries)
        run(infrastructure() + ["up", "-d", "--wait"])
        launch("ollama", ["ollama", "serve"], ROOT, "http://127.0.0.1:11436/api/tags")
        backend_python = str(ROOT / "services/ai-backend/.venv/bin/python")
        launch("ollama-proxy", [backend_python, "-m", "uvicorn", "ollama_proxy:app", "--host", "127.0.0.1", "--port", "11435"], ROOT, "http://127.0.0.1:11435/health")
        for name, port in SERVICES.items():
            directory = ROOT / "services" / name
            launch(name, [str(directory / ".venv/bin/python"), "-m", "uvicorn", "bootstrap:app", "--host", "127.0.0.1", "--port", str(port)], directory, f"http://127.0.0.1:{port}/health")
        launch("ai-backend", [backend_python, "run.py"], ROOT / "services/ai-backend", "http://127.0.0.1:8420/health")
        launch("web", ["bun", "run", "--cwd", "apps/web", "dev", "--hostname", "127.0.0.1"], ROOT, "http://127.0.0.1:3000")
        print("OpenCut: http://127.0.0.1:3000; model downloads occur on demand")
    except BaseException:
        stop(entries)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["setup", "start", "status", "stop", "doctor"])
    parser.add_argument("--with-turboquant", action="store_true", help="Include the optional native TurboQuant backend")
    args = parser.parse_args()
    if args.with_turboquant:
        SERVICES["turboquant-service"] = 8430
    for name in list(SERVICES):
        if not (ROOT / "services" / name).is_dir():
            del SERVICES[name]
    STATE.mkdir(mode=0o700, exist_ok=True)
    with (STATE / "supervisor.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not (STATE / "token").exists():
            (STATE / "token").write_text(secrets.token_urlsafe(32))
            (STATE / "token").chmod(0o600)
        if args.command == "status":
            for name, entry in read_state().items():
                status = "managed" if name == "infrastructure" else "stopped"
                if name != "infrastructure" and live(entry):
                    try:
                        with urllib.request.urlopen(entry["health"], timeout=3) as response:
                            status = "healthy" if response.status == 200 else "unhealthy"
                    except (OSError, urllib.error.URLError):
                        status = "unhealthy"
                print(name, status)
        elif args.command == "stop":
            stop(read_state())
        elif args.command == "doctor":
            preflight()
            print("Native prerequisites ready")
        else:
            globals()[args.command]()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
