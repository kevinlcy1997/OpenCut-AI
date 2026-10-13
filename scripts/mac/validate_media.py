"""Verify measured browser/native outputs before opening automatic export gates."""
import argparse
import hashlib
import platform
import json
from pathlib import Path
import re
import statistics
import subprocess
import numpy as np


def probe(path):
    result = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(path)], check=True, capture_output=True)
    return json.loads(result.stdout)


def audio(path):
    result = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"], check=True, capture_output=True)
    return np.frombuffer(result.stdout, dtype="<f4")


def audio_offset_ms(first, second):
    length = min(len(first), len(second))
    if length == 0: return None
    a, b = first[:length], second[:length]
    if np.max(np.abs(a)) < 1e-5 or np.max(np.abs(b)) < 1e-5: return None
    size = 1 << (2 * length - 1).bit_length()
    correlation = np.fft.irfft(np.fft.rfft(a, size) * np.conj(np.fft.rfft(b, size)), size)
    offsets = np.arange(-1600, 1601)
    best = offsets[np.argmax(correlation[offsets % size])]
    return float(abs(best) / 16)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, default=Path(".mac-runtime/browser-benchmarks"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--enable-gate", action="store_true")
    parser.add_argument("--kind", choices=["export", "proxy"], default="export")
    args = parser.parse_args()
    filename = "video-4k-60s.mp4.json" if args.kind == "export" else "proxy-720p-60s.json"
    report = json.loads((args.directory / filename).read_text())
    browser = [run for run in report["runs"] if run["backend"] == "browser" and run["kind"] == "warm"]
    native = [run for run in report["runs"] if run["backend"] == "videotoolbox" and run["kind"] == "warm"]
    if len(browser) != 3 or len(native) != 3: raise RuntimeError("Three warm runs per backend are required")
    first, second = args.directory / browser[0]["output"], args.directory / native[0]["output"]
    first_probe, second_probe = probe(first), probe(second)
    def video(info): return next(s for s in info["streams"] if s["codec_type"] == "video")
    a, b = video(first_probe), video(second_probe)
    frames_equal = int(a["nb_read_frames"]) == int(b["nb_read_frames"]) == 1800
    duration_difference = abs(float(first_probe["format"]["duration"]) - float(second_probe["format"]["duration"]))
    result = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(first), "-i", str(second), "-lavfi", "[0:v][1:v]ssim", "-an", "-f", "null", "-"], capture_output=True, check=True)
    matches = re.findall(r"All:([0-9.]+)", result.stderr.decode())
    ssim = float(matches[-1]) if matches else 0
    offset = audio_offset_ms(audio(first), audio(second)) if args.kind == "export" else None
    speedup = statistics.median(run["seconds"] for run in browser) / statistics.median(run["seconds"] for run in native)
    effects = json.loads((args.directory / "video-1080p-120s.mp4.json").read_text())
    effects_rejected = all(run.get("native_eligible") is False for run in effects["runs"])
    audio_passed = offset is not None and offset <= 20 if args.kind == "export" else all(not any(stream["codec_type"] == "audio" for stream in info["streams"]) for info in (first_probe, second_probe))
    parity = frames_equal and duration_difference <= 1/30 and ssim >= .99 and audio_passed and effects_rejected
    summary = {"browser_version": report["browser_version"], "speedup": speedup, "frames_equal": frames_equal,
               "duration_difference_seconds": duration_difference, "ssim": ssim, "audio_offset_ms": offset,
               "effects_rejected": effects_rejected, "parity_passed": parity, f"automatic_{args.kind}_passed": parity and speedup >= 1.25,
               "limitations": ["Single 4K SDR 30fps source; other source profiles require additional validation", "Visual comparison is against browser output, not source compression quality"]}
    args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_text(json.dumps(summary, indent=2))
    if args.enable_gate:
        gate = args.directory.parent / "media-gates.json"
        gates = json.loads(gate.read_text()) if gate.exists() else {}
        root = Path(__file__).resolve().parents[2]
        hardware = subprocess.check_output(["sysctl", "-n", "hw.model"], text=True).strip()
        ffmpeg_version = subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0]
        gates[args.kind] = {"ffmpeg_version": ffmpeg_version, "macos_major": platform.mac_ver()[0].split(".")[0], "hardware_model": hardware, "browser_version": report["browser_version"], "implementation_sha256": hashlib.sha256((root / "services/media-service/app.py").read_bytes()).hexdigest(), "parity_passed": parity, "speedup": speedup, "profile": {"source": "4k-sdr-30fps", "output_width": int(a["width"]), "output_height": int(a["height"]), "quality": "high" if args.kind == "export" else "low", "single_clip": True}}
        gate.write_text(json.dumps(gates, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__": main()
