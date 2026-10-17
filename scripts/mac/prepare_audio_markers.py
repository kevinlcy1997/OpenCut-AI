"""Generate a deterministic local stereo fixture for cut/alignment validation."""
import argparse
import hashlib
import json
from pathlib import Path
import wave
import numpy as np


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rate, seed = 44100, 20261016
    times = [.25, 1.25, 1.99, 2.5, 3.75]
    data = np.zeros((4 * rate, 2))
    rng = np.random.default_rng(seed)
    for time in times:
        start, length = round(time * rate), round(.03 * rate)
        data[start:start+length] = .3 * rng.uniform(-1, 1, (length, 2)) * np.hanning(length)[:, None]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(args.output), "wb") as target:
        target.setparams((2, 2, rate, 0, "NONE", "not compressed"))
        target.writeframes(np.round(data * 32767).astype("<i2").tobytes())
    print(json.dumps({"fixture": args.output.name, "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(), "sample_rate": rate, "channels": 2, "duration_seconds": 4, "marker_seconds": times, "seed": seed, "source": "synthetic; no third-party media"}, indent=2))


if __name__ == "__main__": main()
