"""Measure encoded audio on presentation time, not FFmpeg's first decoded sample."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import numpy as np

RATE = 44100


def decode(path):
    result = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-af", "aresample=async=1:first_pts=0", "-ar", str(RATE), "-ac", "2", "-f", "f32le", "pipe:1"], check=True, capture_output=True)
    return np.frombuffer(result.stdout, dtype="<f4").reshape(-1, 2)


def signed_offset_ms(reference, output, max_ms=100):
    """Positive means output lags the reference. Silence cannot establish alignment."""
    length = min(len(reference), len(output))
    if length == 0: return None
    a, b = reference[:length], output[:length]
    if max(abs(a)) < 1e-5 or max(abs(b)) < 1e-5: return None
    size = 1 << (2 * length - 1).bit_length()
    correlation = np.fft.irfft(np.fft.rfft(b, size) * np.conj(np.fft.rfft(a, size)), size)
    limit = round(max_ms * RATE / 1000)
    offsets = np.arange(-limit, limit + 1)
    best = int(np.argmax(correlation[offsets % size]))
    strength = correlation[offsets[best] % size] / np.sqrt(np.sum(a * a) * np.sum(b * b))
    if not np.isfinite(strength) or strength < .3: return None
    return float(offsets[best] * 1000 / RATE)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--encoded", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--markers", type=float, nargs="*", default=[])
    args = parser.parse_args()
    a, b = decode(args.reference), decode(args.encoded)
    offsets = [signed_offset_ms(a[:, channel], b[:, channel]) for channel in range(2)]
    markers = []
    for time in args.markers:
        lo, hi = max(0, int((time - .15) * RATE)), int((time + .15) * RATE)
        markers.append({"time_seconds": time, "offset_ms": [signed_offset_ms(a[lo:hi, channel], b[lo:hi, channel], 50) for channel in range(2)]})
    measured = offsets + [offset for marker in markers for offset in marker["offset_ms"]]
    report = {"reference_sha256": hashlib.sha256(args.reference.read_bytes()).hexdigest(), "encoded_sha256": hashlib.sha256(args.encoded.read_bytes()).hexdigest(), "audio_clock": "presentation time; initial gap preserved", "offset_ms": offsets, "markers": markers, "alignment_passed": all(offset is not None and abs(offset) <= 20 for offset in measured), "limitations": ["Use nonperiodic markers; periodic tones do not uniquely establish alignment", "Alignment only; does not establish codec quality or full timeline parity"]}
    args.report.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report["alignment_passed"] else 1)


if __name__ == "__main__": main()
