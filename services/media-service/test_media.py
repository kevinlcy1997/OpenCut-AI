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

    async def test_cancelled_encoder_retains_lock_until_process_exits(self):
        reading = asyncio.Event()
        terminating = asyncio.Event()
        allow_exit = asyncio.Event()
        async def read():
            reading.set()
            await asyncio.Event().wait()
        async def wait():
            terminating.set()
            await allow_exit.wait()
            first.returncode = 0
        first = SimpleNamespace(returncode=None, stdout=SimpleNamespace(readline=read), stderr=SimpleNamespace(read=AsyncMock(return_value=b"")), terminate=Mock(), kill=Mock(), wait=wait)
        second = SimpleNamespace(returncode=0, stdout=SimpleNamespace(readline=AsyncMock(return_value=b"")), stderr=SimpleNamespace(read=AsyncMock(return_value=b"")), wait=AsyncMock())
        media.jobs["next"] = {"state": "queued", "asset_ids": ["video"]}
        with patch("app.asyncio.create_subprocess_exec", new=AsyncMock(side_effect=[first, second])) as spawn:
            current = asyncio.create_task(media.execute("test", self.request))
            await asyncio.wait_for(reading.wait(), 1)
            current.cancel()
            await asyncio.wait_for(terminating.wait(), 1)
            following = asyncio.create_task(media.execute("next", self.request))
            try:
                await asyncio.sleep(0)
                self.assertEqual(spawn.await_count, 1)
                self.assertEqual(media.jobs["next"]["state"], "queued")
            finally:
                allow_exit.set()
                await asyncio.gather(current, following, return_exceptions=True)
            self.assertEqual(spawn.await_count, 2)
            self.assertEqual(media.jobs["next"]["state"], "complete")

    async def test_queued_cancellation_never_starts_encoder(self):
        await media.worker_lock.acquire()
        try:
            with patch("app.asyncio.create_subprocess_exec", new=AsyncMock()) as spawn:
                task = asyncio.create_task(media.execute("test", self.request))
                await asyncio.sleep(0)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                spawn.assert_not_awaited()
                self.assertEqual(media.jobs["test"]["state"], "cancelled")
        finally:
            media.worker_lock.release()

    async def test_failed_asset_unlink_preserves_retry_handle(self):
        path = media.STORE / "original"
        path.write_bytes(b"original")
        media.assets["unused"] = {"path": path}
        with patch.object(Path, "unlink", side_effect=OSError("storage unavailable")):
            with self.assertRaisesRegex(OSError, "storage unavailable"):
                await media.delete_asset("unused")
        self.assertIn("unused", media.assets)
        self.assertTrue(path.exists())
        self.assertEqual(await media.delete_asset("unused"), {"deleted": True})
        self.assertNotIn("unused", media.assets)
        self.assertFalse(path.exists())

    async def test_output_cleanup_failure_does_not_leak_queue_slot(self):
        process = SimpleNamespace(returncode=1, stdout=SimpleNamespace(readline=AsyncMock(return_value=b"")), stderr=SimpleNamespace(read=AsyncMock(side_effect=[b"encoder failed", b""])), wait=AsyncMock())
        media.tasks["test"] = object()
        with patch("app.asyncio.create_subprocess_exec", new=AsyncMock(return_value=process)), patch.object(Path, "unlink", side_effect=OSError("read only")):
            await media.execute("test", self.request)
        self.assertNotIn("test", media.tasks)
        self.assertEqual(media.jobs["test"]["state"], "failed")
        self.assertIn("cleanup failed", media.jobs["test"]["error"])

    async def test_expiry_retries_failed_files_without_blocking_other_entries(self):
        failed_asset = media.STORE / "stuck-asset"
        failed_job = media.STORE / "stuck-job.mp4"
        normal_asset = media.STORE / "normal-asset"
        normal_job = media.STORE / "normal-job.mp4"
        for path in (failed_asset, failed_job, normal_asset, normal_job): path.write_bytes(b"temporary")
        media.assets.clear(); media.jobs.clear()
        media.assets.update(stuck={"path": failed_asset, "used": 0}, normal={"path": normal_asset, "used": 0})
        media.jobs.update({"stuck-job": {"state": "failed", "updated": 0, "asset_ids": []}, "normal-job": {"state": "complete", "updated": 0, "asset_ids": []}})
        unlink = Path.unlink
        def sometimes_failed(path, *args, **kwargs):
            if path in (failed_asset, failed_job): raise PermissionError("temporary storage error")
            return unlink(path, *args, **kwargs)
        with patch("app.time.time", return_value=4000), patch.object(Path, "unlink", new=sometimes_failed), patch.object(media.logger, "warning") as warning:
            media.cleanup_expired()
            self.assertEqual(warning.call_count, 2)
        self.assertEqual(set(media.assets), {"stuck"})
        self.assertEqual(set(media.jobs), {"stuck-job"})
        self.assertFalse(normal_asset.exists()); self.assertFalse(normal_job.exists())
        with patch("app.time.time", return_value=4060): media.cleanup_expired()
        self.assertEqual(media.assets, {}); self.assertEqual(media.jobs, {})
        self.assertFalse(failed_asset.exists()); self.assertFalse(failed_job.exists())

    async def test_expiry_preserves_active_inputs_and_recent_outputs(self):
        media.assets.clear(); media.jobs.clear()
        paths = {name: media.STORE / name for name in ("active", "recent")}
        for path in paths.values(): path.write_bytes(b"keep")
        media.assets.update(active={"path": paths["active"], "used": 0}, recent={"path": paths["recent"], "used": 3999})
        media.jobs["running"] = {"state": "running", "updated": 0, "asset_ids": ["active"]}
        output = media.STORE / "recent.mp4"; output.write_bytes(b"keep output")
        media.jobs["recent"] = {"state": "complete", "updated": 3999, "asset_ids": []}
        with patch("app.time.time", return_value=4000): media.cleanup_expired()
        self.assertEqual(set(media.assets), {"active", "recent"})
        self.assertEqual(set(media.jobs), {"running", "recent"})
        self.assertTrue(output.exists())
        self.assertTrue(all(path.exists() for path in paths.values()))


if __name__ == "__main__":
    unittest.main()
