import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from coordinator import Lease, NativeGuard, memory_capacity, estimate
from starlette.requests import Request


class LeaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.memory = patch("coordinator.psutil.virtual_memory", return_value=SimpleNamespace(total=16 * 1024**3, available=12 * 1024**3))
        self.memory.start()

    async def asyncTearDown(self):
        self.memory.stop(); self.directory.cleanup()

    async def test_serialization_and_switch(self):
        first = Lease(self.directory.name, "whisper-service", 1024)
        second = Lease(self.directory.name, "image-service", 3072)
        second.unload = AsyncMock()
        await first.acquire()
        waiting = asyncio.create_task(second.acquire())
        await asyncio.sleep(.1)
        self.assertFalse(waiting.done())
        second.unload.assert_not_called()
        first.release()
        await waiting
        second.unload.assert_awaited_once_with("whisper-service")
        self.assertTrue(second.status()["busy"])
        second.release()
        self.assertFalse(second.status()["busy"])

    async def test_cancelled_wait_preserves_holder(self):
        first = Lease(self.directory.name, "whisper-service", 1024)
        second = Lease(self.directory.name, "whisper-service", 1024)
        await first.acquire()
        waiting = asyncio.create_task(second.acquire())
        await asyncio.sleep(.1)
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        self.assertTrue(first.status()["busy"])
        self.assertEqual(first.status()["queued"], 0)
        first.release()

    async def test_reject_large_model(self):
        lease = Lease(self.directory.name, "image-service", 16000)
        with self.assertRaises(MemoryError):
            await lease.acquire()
        self.assertFalse(lease.acquired)
        self.assertEqual(lease.status()["queued"], 0)

    async def test_failed_unload_blocks_switch(self):
        first = Lease(self.directory.name, "whisper-service", 1024)
        await first.acquire(); first.release()
        second = Lease(self.directory.name, "image-service", 3072)
        second.unload = AsyncMock(side_effect=RuntimeError("worker unavailable"))
        with self.assertRaises(RuntimeError):
            await second.acquire()
        self.assertEqual(second.status()["service"], "whisper-service")

    async def test_disconnect_keeps_lease_until_worker_finishes(self):
        running, finish = asyncio.Event(), asyncio.Event()
        async def application(scope, receive, send):
            running.set()
            await finish.wait()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"done"})
        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}
        async def send(message):
            pass
        scope = {"type": "http", "method": "POST", "path": "/transcribe", "query_string": b"", "headers": [], "scheme": "http", "server": ("localhost", 8421)}
        with patch.dict("os.environ", {"OPENCUT_MAC_STATE": self.directory.name, "OPENCUT_MAC_SERVICE": "whisper-service", "OPENCUT_MEDIA_TOKEN": "secret"}):
            task = asyncio.create_task(NativeGuard(application)(scope, receive, send))
            await running.wait()
            task.cancel(); await asyncio.sleep(.05)
            task.cancel(); await asyncio.sleep(.05)
            self.assertTrue(Lease(self.directory.name, "test", 0).status()["busy"])
            self.assertFalse(task.done())
            finish.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertFalse(Lease(self.directory.name, "test", 0).status()["busy"])

    async def test_selected_model_survives_remote_unload(self):
        (Path(self.directory.name) / "selections.json").write_text(json.dumps({"whisper-service": "small"}))
        module = SimpleNamespace(WHISPER_MODEL_SIZE="base")
        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}
        scope = {"type": "http", "method": "POST", "path": "/transcribe", "query_string": b"", "headers": [], "scheme": "http", "server": ("localhost", 8421)}
        with patch.dict("sys.modules", {"app": module}), patch.dict("os.environ", {"OPENCUT_MAC_STATE": self.directory.name, "OPENCUT_MAC_SERVICE": "whisper-service", "OPENCUT_MEDIA_TOKEN": "secret"}):
            response, lease = await NativeGuard(None).admit(Request(scope, receive))
        self.assertIsNone(response)
        self.assertEqual(module.WHISPER_MODEL_SIZE, "small")
        self.assertEqual(lease.status()["model"], "small")
        lease.release()

    async def test_explicit_queue_cancellation_preserves_active_job(self):
        first = Lease(self.directory.name, "whisper-service", 0)
        await first.acquire()
        queued = Lease(self.directory.name, "image-service", 0)
        waiting = asyncio.create_task(queued.acquire())
        await asyncio.sleep(.1)
        identifier = first.status()["queue_entries"][0]["id"]
        async def receive():
            return {"type": "http.request", "body": json.dumps({"ticket_id": identifier}).encode(), "more_body": False}
        scope = {"type": "http", "method": "POST", "path": "/native/cancel", "query_string": b"", "headers": [(b"x-opencut-internal", b"secret")], "scheme": "http", "server": ("localhost", 8421)}
        with patch.dict("os.environ", {"OPENCUT_MAC_STATE": self.directory.name, "OPENCUT_MAC_SERVICE": "whisper-service", "OPENCUT_MEDIA_TOKEN": "secret"}):
            response, _ = await NativeGuard(None).admit(Request(scope, receive))
        self.assertEqual(response.status_code, 200)
        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            await waiting
        self.assertTrue(first.status()["busy"])
        self.assertEqual(first.status()["queue_entries"], [])
        first.release()

    async def test_cancel_rejects_active_ticket(self):
        lease = Lease(self.directory.name, "whisper-service", 0)
        await lease.acquire()
        async def receive():
            return {"type": "http.request", "body": json.dumps({"ticket_id": lease.ticket.name}).encode(), "more_body": False}
        scope = {"type": "http", "method": "POST", "path": "/native/cancel", "query_string": b"", "headers": [(b"x-opencut-internal", b"secret")], "scheme": "http", "server": ("localhost", 8421)}
        with patch.dict("os.environ", {"OPENCUT_MAC_STATE": self.directory.name, "OPENCUT_MAC_SERVICE": "whisper-service", "OPENCUT_MEDIA_TOKEN": "secret"}):
            response, _ = await NativeGuard(None).admit(Request(scope, receive))
        self.assertEqual(response.status_code, 409)
        self.assertTrue(lease.status()["busy"])
        lease.release()

    async def test_crashed_holder_releases_lock_and_ticket(self):
        script = "import asyncio,sys,time; from coordinator import Lease; lease=Lease(sys.argv[1], 'whisper-service', 0); asyncio.run(lease.acquire()); print('ready',flush=True); time.sleep(30)"
        child = subprocess.Popen([sys.executable, "-c", script, self.directory.name], stdout=subprocess.PIPE, cwd=Path(__file__).parent)
        try:
            await asyncio.to_thread(child.stdout.readline)
            next_job = Lease(self.directory.name, "whisper-service", 0)
            waiting = asyncio.create_task(next_job.acquire(timeout=3))
            await asyncio.sleep(.1)
            self.assertFalse(waiting.done())
            child.kill(); await asyncio.to_thread(child.wait)
            await waiting
            self.assertTrue(next_job.acquired)
            next_job.release()
        finally:
            if child.poll() is None: child.kill(); child.wait()
            child.stdout.close()

    async def test_bounded_queue_rejects_ninth_ticket(self):
        queue = Path(self.directory.name) / "queue"
        queue.mkdir()
        for number in range(8):
            (queue / f"{number}.json").write_text(json.dumps({"pid": os.getpid()}))
        with self.assertRaisesRegex(RuntimeError, "queue is full"):
            await Lease(self.directory.name, "whisper-service", 0).acquire()

    def test_memory_reserve_and_known_models(self):
        self.assertEqual(memory_capacity(16384, 10240), 9216)
        self.assertEqual(memory_capacity(8192, 3000), 1976)
        self.assertEqual(memory_capacity(16384, 16000), 12288)
        self.assertEqual(memory_capacity(8192, 1000), 0)
        self.assertIsNone(estimate("image-service", "unknown"))
        self.assertGreater(estimate("image-service", "flux-schnell"), 16384)


if __name__ == "__main__":
    unittest.main()
