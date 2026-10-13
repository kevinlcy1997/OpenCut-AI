"""Download CC-BY fixtures and derive reproducible audio/video test inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request
import wave
import xml.etree.ElementTree as ET
import zipfile

import numpy as np

AMI = "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2002a/audio/"
ANNOTATIONS = "https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip"
BLENDER = "https://download.blender.org/demo/movies/BBB/bbb_sunflower_2160p_30fps_normal.mp4.zip"


def fetch(url, path):
    if path.exists():
        return
    temporary = path.with_suffix(".partial")
    with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as output:
        shutil.copyfileobj(response, output)
    temporary.replace(path)


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, default=Path(".mac-runtime/fixtures"))
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    directory = args.directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / "ami-annotations.zip"
    fetch(ANNOTATIONS, archive)
    words = []
    mixed = np.zeros(600 * 16000, dtype=np.float32)
    sources = []
    with zipfile.ZipFile(archive) as annotations:
        for speaker, channel in [("A", 0), ("B", 1)]:
            name = f"ES2002a.Headset-{channel}.wav"
            source = directory / name
            fetch(AMI + name, source)
            sources.append({"url": AMI + name, "sha256": sha(source)})
            decoded = directory / f"speaker-{speaker}.wav"
            subprocess.run([args.ffmpeg, "-v", "error", "-y", "-i", str(source), "-t", "600", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(decoded)], check=True)
            with wave.open(str(decoded)) as wav:
                samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768
            mask = np.zeros(len(samples), dtype=np.float32)
            root = ET.fromstring(annotations.read(f"words/ES2002a.{speaker}.words.xml"))
            for word in root.findall("w"):
                if word.get("punc") == "true" or not word.text or "starttime" not in word.attrib:
                    continue
                start, end = float(word.get("starttime")), float(word.get("endtime"))
                if start < 0 or end > 600:
                    continue
                words.append({"word": word.text, "start": start, "end": end, "speaker": speaker})
                first, last = max(0, int((start - .15) * 16000)), min(len(samples), int((end + .15) * 16000))
                mask[first:last] = 1
            # Only target-speaker annotated regions are retained; timestamps never shift.
            mixed[:len(samples)] += samples * mask * .5
    speech = directory / "speech-two-speakers-600s.wav"
    with wave.open(str(speech), "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        wav.writeframes((np.clip(mixed, -1, 1) * 32767).astype("<i2").tobytes())
    words.sort(key=lambda word: (word["start"], word["speaker"]))
    (directory / "speech-reference.json").write_text(json.dumps({"words": words, "duration": 600, "derivation": "Headsets A/B gated to annotated speech with 150ms padding; original clock retained"}, indent=2))
    movie_archive = directory / "bbb-4k.zip"
    fetch(BLENDER, movie_archive)
    movie = directory / "bbb_sunflower_2160p_30fps_normal.mp4"
    with zipfile.ZipFile(movie_archive) as movie_zip:
        with movie_zip.open(movie.name) as source, movie.open("wb") as target:
            shutil.copyfileobj(source, target)
    for name, seconds, size in [("video-1080p-120s.mp4", 120, "1920:1080"), ("video-4k-60s.mp4", 60, "3840:2160")]:
        if (directory / name).exists():
            continue
        subprocess.run([args.ffmpeg, "-v", "error", "-y", "-ss", "60", "-i", str(movie), "-t", str(seconds),
                        "-vf", f"scale={size}", "-r", "30", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac", str(directory / name)], check=True)
    manifest = {"speech": {"source": "AMI ES2002a", "license": "CC BY 4.0", "source_page": "https://groups.inf.ed.ac.uk/ami/download/", "sources": sources, "annotations_sha256": sha(archive)},
                "video": {"source": "Big Buck Bunny — Blender Foundation", "license": "CC BY 3.0", "url": BLENDER, "source_page": "https://peach.blender.org/about/", "archive_sha256": sha(movie_archive)},
                "image_prompt": "A ceramic teapot on a wooden table beside a window, soft daylight, detailed product photograph",
                "fixtures": {name: sha(directory / name) for name in ("speech-two-speakers-600s.wav", "speech-reference.json", "video-1080p-120s.mp4", "video-4k-60s.mp4")},
                "projects": [{"fixture": "video-1080p-120s.mp4", "duration": 120, "fps": 30, "effects": ["grayscale"]},
                             {"fixture": "video-4k-60s.mp4", "duration": 60, "fps": 30, "effects": []}]}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(directory / "manifest.json")


if __name__ == "__main__":
    main()
