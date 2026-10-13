import unittest
from types import SimpleNamespace

from device import select_device


def hardware(cuda=False, mps=False):
    return SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: cuda),
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps)),
    )


class DeviceTests(unittest.TestCase):
    def test_auto_selection(self):
        for cuda, mps, expected in [(True, True, "cuda"), (False, True, "mps"), (False, False, "cpu")]:
            with self.subTest(expected=expected):
                self.assertEqual(select_device(hardware(cuda, mps)), expected)

    def test_cpu_override(self):
        self.assertEqual(select_device(hardware(True, True), "cpu"), "cpu")

    def test_unavailable_explicit_device_fails(self):
        for device in ("cuda", "mps"):
            with self.assertRaises(RuntimeError):
                select_device(hardware(), device)

    def test_invalid_device(self):
        with self.assertRaises(ValueError):
            select_device(hardware(), "metal")

    def test_torch_without_mps(self):
        torch = hardware()
        torch.backends = SimpleNamespace()
        self.assertEqual(select_device(torch), "cpu")


if __name__ == "__main__":
    unittest.main()
