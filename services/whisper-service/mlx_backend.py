"""MLX adapter preserving the faster-whisper segment contract and source clock."""
import gc
import importlib
import importlib.util
import platform
import os
import json
import importlib.metadata
from pathlib import Path
from types import SimpleNamespace

PINNED_REVISIONS = {"base": "1e3e249fb8d01c655324bd6841b1deadffd6d04c"}

MODELS = {name: f"mlx-community/whisper-{name}-mlx" for name in ("tiny", "base", "small", "medium", "large-v3")}


def default_precision(size):
    path = Path(__file__).resolve().parents[2] / "scripts/mac/validated-profiles.json"
    if path.exists() and os.getenv("OPENCUT_MAC_HARDWARE"):
        profiles = json.loads(path.read_text()).get("whisper", [])
        for profile in profiles:
            if str(profile.get("macos_major")) == platform.mac_ver()[0].split(".")[0] and profile.get("model_revision") == PINNED_REVISIONS.get(size) and profile["hardware_model"] == os.environ["OPENCUT_MAC_HARDWARE"] and profile["model"] == size and profile["quality_passed"] and profile["speedup"] >= 2:
                if importlib.metadata.version("mlx-whisper") == profile["mlx_whisper_version"] and importlib.metadata.version("mlx") == profile["mlx_version"]:
                    return profile["precision"]
    return "float32"


def choose_backend(requested, system=None, machine=None, installed=None):
    if requested not in {"auto", "mlx", "faster-whisper"}:
        raise ValueError("WHISPER_BACKEND must be auto, mlx, or faster-whisper")
    native = (system or platform.system()) == "Darwin" and (machine or platform.machine()) == "arm64"
    available = native and (installed if installed is not None else importlib.util.find_spec("mlx_whisper") is not None)
    if requested == "mlx" and not available:
        raise RuntimeError("MLX Whisper requires native Apple Silicon and the native dependencies")
    return "mlx" if available and requested in {"auto", "mlx"} else "faster-whisper"


def restore_segment(segment, offset, duration):
    """Clamp local timestamps to the decoded source span, then add its offset."""
    def timestamp(value):
        return offset + min(duration, max(0.0, float(value)))
    start = timestamp(segment["start"])
    end = max(start, timestamp(segment["end"]))
    words = []
    for word in segment.get("words", []):
        word_start = timestamp(word["start"])
        words.append(SimpleNamespace(word=word["word"], start=word_start,
                                     end=max(word_start, timestamp(word["end"])),
                                     probability=float(word.get("probability", 0.0))))
    return SimpleNamespace(text=segment["text"], start=start, end=end, words=words,
                           avg_logprob=float(segment.get("avg_logprob", 0.0)),
                           no_speech_prob=float(segment.get("no_speech_prob", 0.0)))


class MLXModel:
    def __init__(self, size):
        if size not in MODELS:
            raise ValueError(f"Unsupported MLX model size: {size}")
        from huggingface_hub import snapshot_download
        self.revision = PINNED_REVISIONS.get(size)
        self.path = snapshot_download(repo_id=MODELS[size], revision=self.revision)
        self.module = importlib.import_module("mlx_whisper.transcribe")
        import mlx.core as mx
        self.precision = os.getenv("WHISPER_MLX_PRECISION") or default_precision(size)
        if self.precision not in {"float32", "float16"}:
            raise ValueError("WHISPER_MLX_PRECISION must be float32 or float16")
        # Neither path quantizes weights; half precision needs a validated profile or explicit override.
        self.module.ModelHolder.get_model(self.path, getattr(mx, self.precision))

    def transcribe(self, audio_path, language=None, **kwargs):
        from faster_whisper.audio import decode_audio
        from faster_whisper.vad import VadOptions, get_speech_timestamps, collect_chunks, SpeechTimestampsMap
        audio = decode_audio(audio_path, sampling_rate=16000)
        options = VadOptions(min_silence_duration_ms=500, speech_pad_ms=200)
        spans = get_speech_timestamps(audio, options)
        segments = []
        if not spans:
            return iter([]), SimpleNamespace(language=language or "en", duration=len(audio) / 16000)
        compacted = collect_chunks(audio, spans)
        result = self.module.transcribe(compacted, path_or_hf_repo=self.path,
                                        language=language, word_timestamps=True, fp16=self.precision == "float16", verbose=None)
        clock = SpeechTimestampsMap(spans, 16000, time_precision=3)
        for original in result["segments"]:
            segment = dict(original)
            words = []
            for original_word in original.get("words", []):
                word = dict(original_word)
                # A word uses one span for both ends, matching faster-whisper's clock.
                index = clock.get_chunk_index((word["start"] + word["end"]) / 2)
                word["start"] = clock.get_original_time(word["start"], index)
                word["end"] = clock.get_original_time(word["end"], index)
                words.append(word)
            segment["words"] = words
            segment["start"] = words[0]["start"] if words else clock.get_original_time(segment["start"])
            segment["end"] = words[-1]["end"] if words else clock.get_original_time(segment["end"])
            segments.append(restore_segment(segment, 0, len(audio) / 16000))
        return iter(segments), SimpleNamespace(language=result.get("language", language or "en"), duration=len(audio) / 16000)

    def unload(self):
        self.module.ModelHolder.model = None
        self.module.ModelHolder.model_path = None
        gc.collect()
        import mlx.core as mx
        mx.clear_cache()
