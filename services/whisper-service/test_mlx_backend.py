import unittest
from mlx_backend import choose_backend, restore_segment, MLXModel, default_precision, PINNED_REVISIONS
from unittest.mock import patch, Mock
from types import SimpleNamespace
import numpy as np


class MLXTests(unittest.TestCase):
    def test_selection(self):
        self.assertEqual(choose_backend("auto", "Darwin", "arm64", True), "mlx")
        for system, machine, installed in [("Linux", "arm64", True), ("Darwin", "x86_64", True), ("Darwin", "arm64", False)]:
            self.assertEqual(choose_backend("auto", system, machine, installed), "faster-whisper")
        self.assertEqual(choose_backend("faster-whisper", "Darwin", "arm64", True), "faster-whisper")

    def test_explicit_unavailable(self):
        with self.assertRaises(RuntimeError):
            choose_backend("mlx", "Linux", "arm64", True)
        with self.assertRaises(ValueError):
            choose_backend("mps")

    def test_original_clock_after_silence(self):
        segment = restore_segment({"text": "hello", "start": 1, "end": 2,
                                   "words": [{"word": "hello", "start": 1.1, "end": 1.9, "probability": .8}]}, 300, 10)
        self.assertEqual((segment.start, segment.end), (301, 302))
        self.assertEqual((segment.words[0].start, segment.words[0].end), (301.1, 301.9))
        self.assertEqual(segment.words[0].probability, .8)

    def test_chunk_boundaries(self):
        segment = restore_segment({"text": "x", "start": -1, "end": 8,
                                   "words": [{"word": "x", "start": 7, "end": 3}]}, 20, 5)
        self.assertEqual((segment.start, segment.end), (20, 25))
        self.assertEqual((segment.words[0].start, segment.words[0].end), (25, 25))

    def test_precision_profile_requires_validated_weights_and_versions(self):
        versions = {"mlx-whisper": "0.4.3", "mlx": "0.29.3"}
        with patch.dict("os.environ", {"OPENCUT_MAC_HARDWARE": "Mac16,1"}), patch("mlx_backend.platform.mac_ver", return_value=("27.0", (), "arm64")), patch("mlx_backend.importlib.metadata.version", side_effect=lambda name: versions[name]):
            self.assertEqual(default_precision("base"), "float16")
            with patch.dict(PINNED_REVISIONS, {"base": "different-weights"}):
                self.assertEqual(default_precision("base"), "float32")
        with patch.dict("os.environ", {"OPENCUT_MAC_HARDWARE": "unvalidated-mac"}):
            self.assertEqual(default_precision("base"), "float32")

    def test_compacted_vad_restores_gap_and_full_duration(self):
        model = MLXModel.__new__(MLXModel)
        model.path, model.precision = "test", "float32"
        model.module = SimpleNamespace(transcribe=Mock(return_value={"language": "en", "segments": [{"text": "after gap", "start": 1.2, "end": 1.8, "words": [{"word": "after", "start": 1.2, "end": 1.8, "probability": .9}]}]}))
        spans = [{"start": 0, "end": 16000}, {"start": 80000, "end": 96000}]
        with patch("faster_whisper.audio.decode_audio", return_value=np.zeros(160000, dtype=np.float32)), patch("faster_whisper.vad.get_speech_timestamps", return_value=spans):
            segments, info = model.transcribe("fixture")
        segment = next(segments)
        self.assertEqual((segment.start, segment.end), (5.2, 5.8))
        self.assertEqual(info.duration, 10)
        self.assertEqual(len(model.module.transcribe.call_args.args[0]), 32000)

    def test_silence_never_runs_inference(self):
        model = MLXModel.__new__(MLXModel)
        model.module = SimpleNamespace(transcribe=Mock())
        with patch("faster_whisper.audio.decode_audio", return_value=np.zeros(160000, dtype=np.float32)), patch("faster_whisper.vad.get_speech_timestamps", return_value=[]):
            segments, info = model.transcribe("silence", language="fr")
        self.assertEqual(list(segments), [])
        self.assertEqual((info.duration, info.language), (10, "fr"))
        model.module.transcribe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
