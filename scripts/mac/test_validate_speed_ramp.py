import unittest
import numpy as np
from validate_speed_ramp import measure, outside_marker_energy, MARKERS, RATE


class RampTimingTests(unittest.TestCase):
    def fixture(self):
        data = np.zeros((2 * RATE, 2))
        for marker in MARKERS:
            center = round((np.sqrt(1 + 2 * (marker + .015)) - 1) * RATE)
            shape = np.hanning(200) * .2
            data[center-100:center+100] = shape[:, None]
        return data

    def test_aligned_markers_have_zero_offset(self):
        data = self.fixture()
        self.assertTrue(all(abs(x) < 1e-8 for item in measure(data, data) for x in item['energy_centroid_offset_ms']))
        self.assertEqual(outside_marker_energy(data), [0, 0])

    def test_lagging_markers_exceed_acceptance(self):
        data = self.fixture()
        delayed = np.zeros_like(data)
        offset = round(.025 * RATE)
        delayed[offset:] = data[:-offset]
        self.assertTrue(all(x > 24 for item in measure(data, delayed) for x in item['energy_centroid_offset_ms']))

    def test_silence_and_continuous_noise_cannot_pass(self):
        data = self.fixture()
        silence = np.zeros_like(data)
        self.assertTrue(all(x is None for item in measure(data, silence) for x in item['energy_centroid_offset_ms']))
        self.assertEqual(outside_marker_energy(silence), [None, None])
        noise = np.random.default_rng(1).normal(0, .1, data.shape)
        self.assertTrue(all(x > .1 for x in outside_marker_energy(noise)))

class HoldTimingTests(unittest.TestCase):
    def test_independent_step_mapping_at_and_around_boundary(self):
        from validate_speed_ramp import timeline_at_source
        self.assertEqual(timeline_at_source(.5, 'hold'), .5)
        self.assertEqual(timeline_at_source(1, 'hold'), 1)
        self.assertAlmostEqual(timeline_at_source(1.3, 'hold'), 1.1)
        self.assertAlmostEqual(timeline_at_source(4, 'hold'), 2)
        with self.assertRaises(ValueError): timeline_at_source(1, 'unknown')

    def test_boundary_marker_is_measured_on_both_channels(self):
        markers = [.25, .99, 1.25, 1.99, 2.5, 3.75]
        centers = [.265, 1.0016666666666667, 1.0883333333333334, 1.335, 1.505, 1.9216666666666666]
        data = np.zeros((2*RATE, 2))
        for time in centers:
            center = round(time * RATE)
            data[center-100:center+100] = (.2*np.hanning(200))[:, None]
        results = measure(data, data, 'hold', markers)
        self.assertTrue(all(abs(x) < 1e-8 for item in results for x in item['energy_centroid_offset_ms']))
        self.assertEqual(outside_marker_energy(data, 'hold', markers), [0, 0])


if __name__ == '__main__': unittest.main()
