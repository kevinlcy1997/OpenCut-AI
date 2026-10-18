"""Measure marker energy timing for the fixed 1x→3x, two-second audio fixture.

Independent mappings cover a linear ramp and a step at timeline second one. Waveform correlation is not
appropriate for this test because rate automation/resampling changes phase.
This does not verify pitch, codec quality, preview or arbitrary speed curves.
"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from validate_audio import decode, RATE

MARKERS = [.25, 1.25, 1.99, 2.5, 3.75]


def timeline_at_source(value, curve="linear"):
    if curve == "linear": return float(np.sqrt(1 + 2 * value) - 1)
    if curve == "hold": return value if value <= 1 else 1 + (value - 1) / 3
    raise ValueError("Unknown speed curve")


def measure(reference, encoded, curve="linear", marker_times=MARKERS):
    results = []
    for source_time in marker_times:
        center = timeline_at_source(source_time + .015, curve)
        lo, hi = max(0, round((center - .05) * RATE)), round((center + .05) * RATE)
        offsets = []
        for channel in range(2):
            def centroid(samples):
                values = samples[lo:hi, channel].astype(float) ** 2
                energy = values.sum()
                if energy < 1e-8:
                    return None
                return float(np.dot(np.arange(len(values)) + lo, values) / energy / RATE)
            expected, actual = centroid(reference), centroid(encoded)
            offsets.append(None if expected is None or actual is None else (actual - expected) * 1000)
        results.append({"source_marker_seconds": source_time, "expected_window_center_seconds": center, "energy_centroid_offset_ms": offsets})
    return results


def outside_marker_energy(encoded, curve="linear", marker_times=MARKERS):
    mask = np.zeros(len(encoded), dtype=bool)
    for source_time in marker_times:
        center = timeline_at_source(source_time + .015, curve)
        lo, hi = max(0, round((center - .05) * RATE)), round((center + .05) * RATE)
        mask[lo:hi] = True
    energy = encoded.astype(float) ** 2
    total = energy.sum(axis=0)
    return [None if value <= 1e-8 or not np.isfinite(value) else float(energy[~mask, channel].sum() / value) for channel, value in enumerate(total)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--curve", choices=["linear", "hold"], default="linear")
    parser.add_argument("--markers", type=float, nargs="+", default=MARKERS)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--encoded", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    source, encoded = decode(args.source), decode(args.encoded)
    t = np.arange(2 * RATE) / RATE
    positions = (t + t * t / 2 if args.curve == "linear" else np.where(t < 1, t, 1 + 3 * (t - 1))) * RATE
    reference = np.column_stack([np.interp(positions, np.arange(len(source)), source[:, channel], left=0, right=0) for channel in range(2)])
    markers = measure(reference, encoded, args.curve, args.markers)
    offsets = [offset for marker in markers for offset in marker["energy_centroid_offset_ms"]]
    outside = outside_marker_energy(encoded, args.curve, args.markers)
    report = {"outside_marker_energy_fraction": outside, "source_sha256": hashlib.sha256(args.source.read_bytes()).hexdigest(), "encoded_sha256": hashlib.sha256(args.encoded.read_bytes()).hexdigest(), "method": "per-channel marker energy centroid on presentation time", "curve": args.curve, "source_mapping": "t+t*t/2" if args.curve == "linear" else "t for t<1; 1+3*(t-1) otherwise", "markers": markers, "marker_timing_passed": all(offset is not None and abs(offset) <= 20 for offset in offsets) and all(value is not None and value < .01 for value in outside), "limitations": ["Fixed two-second linear/hold speed fixtures only", "Energy timing only; not waveform fidelity, pitch, preview alignment or arbitrary curve parity", "Energy timing does not establish raw-waveform correlation"]}
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report["marker_timing_passed"] else 1)


if __name__ == "__main__":
    main()
