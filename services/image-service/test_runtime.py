"""No model downloads/GPU needed: exercise scheduling and pipeline ownership."""
import asyncio
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch, PropertyMock

from fastapi.testclient import TestClient
import app


class Generator:
    def __init__(self, **kwargs):
        pass

    def manual_seed(self, seed):
        return self


def fake_torch():
    return SimpleNamespace(
        Generator=Generator, float32="float32", float16="float16",
        cuda=SimpleNamespace(is_available=lambda: False),
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
    )


class ImageRuntimeTests(unittest.TestCase):
    def assert_health_during(self, client, path, started, release, **kwargs):
        operation, health = {}, {}
        health_done = threading.Event()

        def request():
            try:
                operation['response'] = client.post(path, **kwargs)
            except BaseException as error:
                operation['error'] = error

        def ping():
            try:
                health['response'] = client.get('/health')
            except BaseException as error:
                health['error'] = error
            finally:
                health_done.set()

        operation_thread = threading.Thread(target=request)
        health_thread = threading.Thread(target=ping)
        operation_thread.start()
        try:
            self.assertTrue(started.wait(2), 'operation never started')
            health_thread.start()
            self.assertTrue(health_done.wait(1), 'health blocked behind model work')
            self.assertEqual(health['response'].status_code, 200)
            self.assertNotIn('response', operation, 'operation completed before responsiveness was checked')
        finally:
            release.set()
            operation_thread.join(5)
            if health_thread.ident is not None:
                health_thread.join(5)
        self.assertFalse(operation_thread.is_alive())
        self.assertFalse(health_thread.is_alive())
        if 'error' in operation:
            raise operation['error']
        self.assertEqual(operation['response'].status_code, 200)

    def test_health_responds_while_model_load_blocks(self):
        started, release = threading.Event(), threading.Event()

        def load(name):
            started.set()
            if not release.wait(5):
                raise RuntimeError('test model load not released')
            return {'status': 'loaded'}

        with patch.object(app.diffusion_service, 'load_model', side_effect=load), TestClient(app.app) as client:
            self.assert_health_during(client, '/load?model_name=fixture', started, release)

    def test_health_responds_during_real_generate_dispatch(self):
        started, release = threading.Event(), threading.Event()

        class Pipeline:
            device = 'cpu'

            def __call__(self, **kwargs):
                started.set()
                if not release.wait(5):
                    raise RuntimeError('test inference not released')
                return SimpleNamespace(images=[SimpleNamespace(save=lambda path: Path(path).write_bytes(b'fixture'))])

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(app, 'GENERATED_DIR', directory), \
                patch.object(app.diffusion_service, '_pipeline', Pipeline()), \
                patch.object(app.diffusion_service, '_device', 'cpu'), \
                patch.object(app.DiffusionService, 'is_installed', new_callable=PropertyMock, return_value=True), \
                patch.dict('sys.modules', {'torch': fake_torch()}), \
                TestClient(app.app) as client:
            self.assert_health_during(client, '/generate', started, release, json={'prompt': 'fixture', 'seed': 42})

    def test_unload_waits_until_inference_finishes(self):
        started, release, unloading, unloaded = (threading.Event() for _ in range(4))

        class Pipeline:
            device = 'cpu'

            def __call__(self, **kwargs):
                started.set()
                if not release.wait(5):
                    raise RuntimeError('test inference not released')
                return SimpleNamespace(images=[SimpleNamespace(save=lambda path: Path(path).write_bytes(b'fixture'))])

        def unload():
            unloading.set()
            app.diffusion_service.unload()
            unloaded.set()

        async def run():
            generation = asyncio.create_task(app.diffusion_service.generate('fixture'))
            task = None
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                task = asyncio.create_task(asyncio.to_thread(unload))
                self.assertTrue(await asyncio.to_thread(unloading.wait, 2))
                self.assertFalse(await asyncio.to_thread(unloaded.wait, .05))
                self.assertTrue(app.diffusion_service.is_loaded)
            finally:
                release.set()
                await generation
                if task:
                    await task
            self.assertTrue(unloaded.is_set())
            self.assertFalse(app.diffusion_service.is_loaded)

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(app, 'GENERATED_DIR', directory), \
                patch.object(app.diffusion_service, '_pipeline', Pipeline()), \
                patch.object(app.diffusion_service, '_device', 'cpu'), \
                patch.dict('sys.modules', {'torch': fake_torch()}):
            asyncio.run(run())

    def test_failed_device_transfer_does_not_publish_partial_pipeline(self):
        pipeline = SimpleNamespace(to=lambda device: (_ for _ in ()).throw(RuntimeError('device transfer failed')))
        diffusers = SimpleNamespace(AutoPipelineForText2Image=SimpleNamespace(from_pretrained=lambda *args, **kwargs: pipeline))
        with patch.object(app.diffusion_service, '_pipeline', None), \
                patch.object(app, 'IMAGE_DEVICE', 'cpu'), \
                patch.object(app.DiffusionService, 'is_installed', new_callable=PropertyMock, return_value=True), \
                patch.dict('sys.modules', {'torch': fake_torch(), 'diffusers': diffusers}):
            result = app.diffusion_service.load_model('fixture')
            self.assertEqual(result['status'], 'error')
            self.assertFalse(app.diffusion_service.is_loaded)


if __name__ == '__main__':
    unittest.main()
