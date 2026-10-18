import unittest
import numpy as np
from validate_audio import RATE, signed_offset_ms

class AudioClockTests(unittest.TestCase):
    def test_detects_signed_offsets_on_nonperiodic_markers(self):
        reference = np.zeros(RATE)
        reference[10000:11000] = np.random.default_rng(42).normal(size=1000)
        for shift in (-882, 0, 441):
            with self.subTest(shift=shift):
                output = np.zeros(RATE)
                output[10000+shift:11000+shift] = reference[10000:11000]
                self.assertAlmostEqual(signed_offset_ms(reference, output), shift * 1000 / RATE)

    def test_unrelated_audio_does_not_pass_alignment(self):
        rng = np.random.default_rng(42)
        self.assertIsNone(signed_offset_ms(rng.normal(size=RATE), rng.normal(size=RATE)))

    def test_silence_does_not_pass_alignment(self):
        self.assertIsNone(signed_offset_ms(np.zeros(RATE), np.zeros(RATE)))

if __name__ == "__main__": unittest.main()
