import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import runtime


class RuntimeTests(unittest.TestCase):
    def test_production_web_is_default_and_development_is_explicit(self):
        build, server = runtime.web_commands()
        self.assertEqual(build[-1], "build")
        self.assertIn("start", server)
        self.assertNotIn("dev", server)
        build, server = runtime.web_commands(development=True)
        self.assertIsNone(build)
        self.assertIn("dev", server)

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



class ReadinessTests(unittest.TestCase):
    def test_missing_required_services_are_not_ready(self):
        with patch("runtime.process_status", side_effect=lambda item: (item[0], "healthy")):
            result = runtime.runtime_status({"web": {}})
        self.assertFalse(result["ready"])
        self.assertEqual(result["services"]["ai-backend"], "missing")

    def test_all_owned_services_must_be_healthy(self):
        names = {"infrastructure", "web", "ai-backend", "ollama", "ollama-proxy", *runtime.SERVICES}
        entries = {name: {} for name in names}
        with patch("runtime.process_status", side_effect=lambda item: (item[0], "healthy")):
            self.assertTrue(runtime.runtime_status(entries)["ready"])
        with patch("runtime.process_status", side_effect=lambda item: (item[0], "stopped" if item[0] == "web" else "healthy")):
            self.assertFalse(runtime.runtime_status(entries)["ready"])

    def test_reused_pid_cannot_pass_health(self):
        with patch("runtime.live", return_value=False), patch("runtime.urllib.request.urlopen") as request:
            self.assertEqual(runtime.process_status(("web", {})), ("web", "stopped"))
        request.assert_not_called()

    def test_infrastructure_checks_actual_container_state(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory); (state / "compose.json").write_text("{}")
            rows = [{"Service": name, "State": "running", "Health": "healthy"} for name in ("db", "redis", "redis-http")]
            import json
            with patch("runtime.STATE", state), patch("runtime.subprocess.run", return_value=SimpleNamespace(stdout=json.dumps(rows))):
                self.assertEqual(runtime.infrastructure_status(), "healthy")
            rows[0]["State"] = "exited"
            with patch("runtime.STATE", state), patch("runtime.subprocess.run", return_value=SimpleNamespace(stdout=json.dumps(rows))):
                self.assertEqual(runtime.infrastructure_status(), "unhealthy (db)")


class StatusCommandTests(unittest.TestCase):
    def test_status_is_read_only_and_returns_failure_for_an_unready_stack(self):
        import io
        import json
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            output = io.StringIO()
            report = {"ready": False, "services": {"web": "stopped"}}
            with patch("runtime.STATE", state), patch("runtime.sys.argv", ["runtime", "status", "--json"]), patch("runtime.read_state", return_value={}), patch("runtime.runtime_status", return_value=report), patch("runtime.sys.stdout", output), patch("runtime.fcntl.flock") as lock:
                with self.assertRaises(SystemExit) as error:
                    runtime.main()
            self.assertEqual(error.exception.code, 3)
            self.assertEqual(json.loads(output.getvalue()), report)
            self.assertFalse((state / "token").exists())
            lock.assert_not_called()


class StateSafetyTests(unittest.TestCase):
    def test_invalid_process_state_is_preserved_and_rejected(self):
        for content in ("{bad", "[]", '{"web":{"pid":1,"identity":"x","health":"http://127.0.0.1:3000"}}'):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                state = Path(directory); (state / "processes.json").write_text(content)
                with patch("runtime.STATE", state):
                    with self.assertRaisesRegex(RuntimeError, "preserve the file"):
                        runtime.read_state()
                self.assertEqual((state / "processes.json").read_text(), content)


if __name__ == "__main__": unittest.main()
