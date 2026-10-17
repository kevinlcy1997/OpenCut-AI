"""Inspect the fixed 4s video→red-card fixture with 25% gain/hard-left tone.

This is a fixture acceptance measurement, not general project/color parity.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import numpy as np
from validate_audio import decode, RATE


def frames(path, duration=None):
    command = ['ffmpeg', '-v', 'error', '-i', str(path)]
    if duration is not None: command += ['-t', str(duration)]
    command += ['-vf', 'scale=320:180', '-an', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']
    return np.frombuffer(subprocess.run(command, check=True, capture_output=True).stdout, dtype=np.uint8).reshape(-1, 180, 320, 3).astype(float)


def amplitude(samples, frequency):
    time = np.arange(len(samples)) / RATE
    return float(2 * abs(np.dot(samples, np.exp(-2j * np.pi * frequency * time))) / len(samples))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--video', type=Path, required=True)
    parser.add_argument('--tone', type=Path, required=True)
    parser.add_argument('--encoded', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(args.encoded)], text=True))
    video = next(item for item in probe['streams'] if item['codec_type'] == 'video')
    numerator, denominator = map(float, video['r_frame_rate'].split('/'))
    fps = numerator / denominator
    duration = float(video['duration'])
    source, output = frames(args.video, 2), frames(args.encoded)
    video_error = float(np.abs(output[:60] - source[:60]).mean()) if len(output) >= 60 and len(source) >= 60 else None
    interiors = output[:, 54:126, 88:232].mean(axis=(1, 2))
    card_flags = (interiors[:, 0] > 245) & (interiors[:, 1] < 5) & (interiors[:, 2] < 5)
    card_indices = np.flatnonzero(card_flags)
    first_card_frame = int(card_indices[0]) if len(card_indices) else None
    cut_ok = len(output) == 120 and not card_flags[:60].any() and card_flags[60:].all()
    red = output[60:, 54:126, 88:232]
    corners = output[60:, :30, :60]
    red_mean = red.mean(axis=(0, 1, 2)).tolist() if red.size else []
    corner_max = float(corners.max()) if corners.size else None
    last = output[-1] if len(output) else np.zeros((180, 320, 3))
    ys, xs = np.where((last[:, :, 0] > 200) & (last[:, :, 1] < 20) & (last[:, :, 2] < 20))
    bounds = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if len(xs) else []
    bounds_ok = len(bounds) == 4 and all(abs(a-b) <= 2 for a, b in zip(bounds, [80, 45, 240, 135]))
    tone, encoded = decode(args.tone), decode(args.encoded)
    lo, hi = RATE // 2, RATE * 7 // 2
    gain = [amplitude(encoded[lo:hi, 0], f) / amplitude(tone[lo:hi, channel], f) for channel, f in enumerate([440, 880])]
    left_rms, right_rms = np.sqrt(np.mean(encoded[lo:hi] ** 2, axis=0))
    pan_ratio = float(right_rms / left_rms) if left_rms > 1e-8 else None
    passed = cut_ok and abs(fps - 30) < 1e-6 and abs(duration - 4) < 1/30 and bounds_ok and len(output) == 120 and video_error is not None and video_error < 5 and len(red_mean) == 3 and red_mean[0] > 245 and max(red_mean[1:]) < 5 and corner_max is not None and corner_max < 5 and all(abs(value - .25) < .005 for value in gain) and pan_ratio is not None and pan_ratio < .001
    report = {'first_still_frame': first_card_frame, 'expected_first_still_frame': 60, 'fps': fps, 'video_duration_seconds': duration, 'red_card_bounds_xyxy': bounds, 'expected_red_card_bounds_xyxy': [80,45,240,135], 'encoded_sha256': hashlib.sha256(args.encoded.read_bytes()).hexdigest(), 'frames': len(output), 'expected_frames': 120, 'first_60_frames_rgb_mae': video_error, 'last_60_frames_red_interior_mean_rgb': red_mean, 'black_margin_max_rgb': corner_max, 'left_channel_gain_at_440_880_hz': gain, 'right_to_left_rms_ratio': pan_ratio, 'fixture_passed': passed, 'limitations': ['Fixed 320x180, 30fps video/still/audio fixture only', 'Video RGB error threshold is a smoke check, not full color or perceptual quality parity', 'No transitions, captions, masks, effects, arbitrary color transforms or live preview validation', 'Tone amplitude verifies gain/pan, not precise audio/video alignment']}
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if passed else 1)


if __name__ == '__main__': main()
