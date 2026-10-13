import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import runtime


class RuntimeTests(unittest.TestCase):
    def test_intel_executable_rejected_even_with_rosetta(self):
        with patch("runtime.shutil.which", return_value="/tool"), patch("runtime.subprocess.run", return_value=SimpleNamespace(stdout="Mach-O 64-bit executable x86_64")):
            with self.assertRaisesRegex(RuntimeError, "Intel executable"):
                runtime.executable("ffmpeg")

    def test_stop_ignores_reused_process_id(self):
        with patch("runtime.identity", return_value="new identity"), patch("runtime.os.kill") as kill, patch("runtime.save"):
            runtime.stop({"web": {"pid": 123, "identity": "old identity"}})
        kill.assert_not_called()

    def test_setup_preserves_existing_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = root / "apps/web/.env.local"
            env.parent.mkdir(parents=True)
            env.write_text("EXISTING=user-value\n")
            lock = root / "scripts/mac/locks/ai-backend.lock"
            lock.parent.mkdir(parents=True); lock.touch()
            with patch.multiple(runtime, ROOT=root, SERVICES={}), patch("runtime.preflight"), patch("runtime.run"):
                runtime.setup()
            self.assertEqual(env.read_text(), "EXISTING=user-value\n")

    def test_database_initializes_fresh_schema_and_skips_repeat_push(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            schema = root / "apps/web/src/lib/db/schema.ts"
            schema.parent.mkdir(parents=True); schema.write_text("schema-v1")
            with patch.multiple(runtime, ROOT=root, STATE=root), patch("runtime.infrastructure", return_value=["docker", "compose"]), patch("runtime.run", side_effect=[SimpleNamespace(stdout="0"), SimpleNamespace()]) as run:
                runtime.initialize_database({})
                self.assertEqual(run.call_count, 2)
            with patch.multiple(runtime, ROOT=root, STATE=root), patch("runtime.infrastructure", return_value=["docker", "compose"]), patch("runtime.run", return_value=SimpleNamespace(stdout="1")) as run:
                runtime.initialize_database({})
                self.assertEqual(run.call_count, 1)

    def test_database_refuses_unknown_existing_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.multiple(runtime, ROOT=root, STATE=root), patch("runtime.infrastructure", return_value=["docker", "compose"]), patch("runtime.run", return_value=SimpleNamespace(stdout="1")) as run:
                with self.assertRaisesRegex(RuntimeError, "reviewed migration"):
                    runtime.initialize_database({})
                self.assertEqual(run.call_count, 1)


if __name__ == "__main__": unittest.main()
