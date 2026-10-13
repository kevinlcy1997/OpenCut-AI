import asyncio
import hashlib
import json
import tempfile
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, patch
from types import SimpleNamespace
from fastapi.testclient import TestClient
import app as media


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch = patch.multiple(media, STORE=Path(self.temp.name), TOKEN="test-secret")
        self.patch.start()
        media.assets.clear(); media.jobs.clear(); media.tasks.clear()

    def tearDown(self):
        self.patch.stop(); self.temp.cleanup()

    def test_auth_origin_and_opaque_assets(self):
        with TestClient(media.app) as client, patch("app.probe", new=AsyncMock(return_value={"video": True, "duration": 10, "hdr": False})):
            self.assertEqual(client.get("/health").status_code, 200)
            self.assertEqual(client.get("/capabilities").status_code, 401)
            headers = {"Authorization": "Bearer test-secret", "Origin": "https://evil.example"}
            self.assertEqual(client.post("/assets", headers=headers, files={"file": ("../../escape", b"test")}).status_code, 403)
            headers["Origin"] = "http://localhost:3000"
            response = client.post("/assets", headers=headers, files={"file": ("../../escape", b"test")})
            self.assertEqual(response.status_code, 200)
            asset = response.json()["asset_id"]
            self.assertEqual(len(asset), 32)
            self.assertTrue((media.STORE / asset).exists())
            self.assertEqual(client.delete(f"/assets/{asset}", headers=headers).status_code, 200)

    def test_codec_specific_command_and_audio_mix(self):
        media.assets.update(video={"path": Path("source")}, audio={"path": Path("mixed.wav")})
        request = media.JobRequest(clips=[media.Clip(asset_id="video", start=2, duration=3)], audio_asset_id="audio")
        args = media.command(request, Path("out.mp4"))
        self.assertIn("h264_videotoolbox", args)
        self.assertNotIn("-preset", args)
        self.assertIn("-protocol_whitelist", args)
        self.assertIn("file,pipe", args)
        self.assertNotIn("http", media.INPUT_FORMATS)
        self.assertIn("1:a:0", args)
        self.assertIn("-allow_sw", args)
        self.assertIn("trim=start=2.0:duration=3.0", args[args.index("-filter_complex") + 1])

    def test_invalid_assets_and_odd_dimensions(self):
        with self.assertRaises(ValueError):
            media.command(media.JobRequest(clips=[media.Clip(asset_id="missing", duration=1)]), Path("out"))
        media.assets["video"] = {"path": Path("source")}
        with self.assertRaises(ValueError):
            media.command(media.JobRequest(clips=[media.Clip(asset_id="video", duration=1)], width=1919), Path("out"))

    def test_automatic_profile_rejects_unvalidated_color_depth(self):
        media.assets["video"] = {"path": Path("source"), "metadata": {"codec": "h264", "width": 3840, "height": 2160, "fps": 30, "pixel_format": "yuv420p10le", "color_primaries": "bt2020"}}
        with self.assertRaisesRegex(ValueError, "color/bit-depth"):
            media.command(media.JobRequest(clips=[media.Clip(asset_id="video", duration=1)], validated_profile="4k-sdr-30fps"), Path("out"))

    def test_unsupported_timeline_fields_are_rejected(self):
        with self.assertRaises(ValueError):
            media.JobRequest(clips=[{"asset_id": "x", "duration": 1, "speed": 2}])
        with self.assertRaises(ValueError):
            media.JobRequest(clips=[{"asset_id": "x", "duration": 1}], effects=["blur"])

    def test_unvalidated_automatic_routes_disabled(self):
        with TestClient(media.app) as client, patch("app.capabilities", new=AsyncMock(return_value={"hardware_available": False, "automatic": {"proxy": False, "export": False}})):
            response = client.post("/jobs", headers={"Authorization": "Bearer test-secret"}, json={"clips": [{"asset_id": "x", "duration": 1}]})
            self.assertEqual(response.status_code, 503)


class JobLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch = patch.multiple(media, STORE=Path(self.temp.name), worker_lock=asyncio.Lock())
        self.patch.start()
        media.assets.clear(); media.jobs.clear(); media.tasks.clear()
        media.assets["video"] = {"path": Path("source")}
        media.jobs["test"] = {"state": "queued", "asset_ids": ["video"]}
        self.request = media.JobRequest(clips=[media.Clip(asset_id="video", duration=1)])

    async def asyncTearDown(self):
        self.patch.stop(); self.temp.cleanup()

    async def test_gate_requires_matching_hardware_and_implementation(self):
        state = Path(self.temp.name)
        gate = {"proxy": {"parity_passed": True, "speedup": 1.3, "hardware_model": "Mac16,1", "ffmpeg_version": "ffmpeg-test", "macos_major": "27", "implementation_sha256": hashlib.sha256(Path(media.__file__).read_bytes()).hexdigest(), "profile": {"source": "4k-sdr-30fps", "output_width": 1280, "output_height": 720}}}
        (state / "media-gates.json").write_text(json.dumps(gate))
        with patch("app.platform.mac_ver", return_value=("27.0", (), "arm64")), patch.multiple(media, STATE=state, _hardware_available=True, _ffmpeg_version="ffmpeg-test"), patch.dict("os.environ", {"OPENCUT_MAC_HARDWARE": "Mac16,1"}):
            self.assertTrue((await media.capabilities())["automatic"]["proxy"])
            gate["proxy"]["implementation_sha256"] = "outdated"
            (state / "media-gates.json").write_text(json.dumps(gate))
            self.assertFalse((await media.capabilities())["automatic"]["proxy"])

    async def test_worker_failure_does_not_leave_output(self):
        process = SimpleNamespace(returncode=1, stdout=SimpleNamespace(readline=AsyncMock(return_value=b"")), stderr=SimpleNamespace(read=AsyncMock(side_effect=[b"hardware unavailable", b""])), wait=AsyncMock())
        with patch("app.asyncio.create_subprocess_exec", new=AsyncMock(return_value=process)):
            await media.execute("test", self.request)
        self.assertEqual(media.jobs["test"]["state"], "failed")
        self.assertIn("hardware unavailable", media.jobs["test"]["error"])
        self.assertFalse((media.STORE / "test.mp4").exists())

    async def test_cancel_running_job_terminates_owned_encoder(self):
        started = asyncio.Event()
        async def read():
            started.set(); await asyncio.Event().wait()
        process = SimpleNamespace(returncode=None, stdout=SimpleNamespace(readline=read), stderr=SimpleNamespace(read=AsyncMock(return_value=b"")), terminate=Mock(), kill=Mock(), wait=AsyncMock())
        with patch("app.asyncio.create_subprocess_exec", new=AsyncMock(return_value=process)):
            task = asyncio.create_task(media.execute("test", self.request))
            await started.wait(); task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
        self.assertEqual(media.jobs["test"]["state"], "cancelled")
        process.terminate.assert_called_once()
        process.wait.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
