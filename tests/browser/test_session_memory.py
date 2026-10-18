import importlib.util
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import psutil

spec = importlib.util.spec_from_file_location('session_memory', Path(__file__).with_name('session-memory.py'))
memory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(memory)


class MemorySamplerTests(unittest.TestCase):
    def test_denied_swap_is_explicit_but_other_telemetry_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / 'processes.json').write_text('{}')
            parent = SimpleNamespace(children=lambda **kwargs: [])
            with patch.object(memory.psutil, 'swap_memory', side_effect=OSError('denied')), patch.object(memory.psutil, 'virtual_memory', return_value=SimpleNamespace(available=123)):
                sample = memory.collect(parent, state)
            self.assertIsNone(sample['swap_bytes'])
            self.assertEqual(sample['available_bytes'], 123)
            self.assertTrue(any('swap_bytes: OSError' in error for error in sample['errors']))

    def test_parent_death_or_reused_pid_and_zombies_stop_sampling(self):
        for running, status in [(False, 'running'), (True, psutil.STATUS_ZOMBIE)]:
            parent = SimpleNamespace(is_running=lambda: running, status=lambda: status)
            self.assertFalse(memory.parent_alive(parent))
        parent = SimpleNamespace(is_running=lambda: True, status=lambda: 'running')
        self.assertTrue(memory.parent_alive(parent))

    def test_run_exits_when_owning_parent_disappears(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'samples.jsonl'
            with patch.object(memory, 'running', True), patch.object(memory, 'parent_alive', side_effect=[True, False]), patch.object(memory, 'collect', return_value={'sample': 1}), patch.object(memory.time, 'sleep'):
                memory.run(object(), Path(directory), output)
            self.assertEqual(output.read_text().splitlines(), ['{"sample": 1}'])

    def test_native_pid_reuse_is_not_counted_as_owned_memory(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / 'processes.json').write_text(json.dumps({'web': {'pid': 123, 'identity': time.ctime(1000)}}))
            parent = SimpleNamespace(children=lambda **kwargs: [])
            replacement = SimpleNamespace(create_time=lambda: 2000, memory_info=lambda: SimpleNamespace(rss=999))
            with patch.object(memory.psutil, 'swap_memory', return_value=SimpleNamespace(used=10)), patch.object(memory.psutil, 'virtual_memory', return_value=SimpleNamespace(available=123)), patch.object(memory.psutil, 'Process', return_value=replacement):
                sample = memory.collect(parent, state)
            self.assertEqual(sample['native_rss_bytes'], 0)
            self.assertIn('native process identity changed or unavailable', sample['errors'])

    def test_unreadable_browser_tree_cannot_be_reported_as_valid_zero_memory(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / 'processes.json').write_text('{}')
            with patch.object(memory.psutil, 'swap_memory', return_value=SimpleNamespace(used=10)), patch.object(memory.psutil, 'virtual_memory', return_value=SimpleNamespace(available=123)), patch.object(memory.psutil.Process, 'children', side_effect=psutil.AccessDenied(123)):
                sample = memory.collect(psutil.Process(), state)
            self.assertEqual(sample['browser_processes'], 0)
            self.assertTrue(any('browser tree: AccessDenied' in error for error in sample['errors']))

    def test_missing_native_workers_are_reported_instead_of_zero_valid_memory(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / 'processes.json').write_text('{}')
            with patch.object(memory.psutil, 'swap_memory', return_value=SimpleNamespace(used=10)), patch.object(memory.psutil, 'virtual_memory', return_value=SimpleNamespace(available=123)):
                sample = memory.collect(SimpleNamespace(children=lambda **kwargs: []), state)
            self.assertTrue(any('native ownership entries missing:' in error for error in sample['errors']))


if __name__ == '__main__':
    unittest.main()
