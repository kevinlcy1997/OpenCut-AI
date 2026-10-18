"""Read-only process-tree and host swap sampling for the opt-in browser soak."""
import argparse
import json
import signal
import time
from pathlib import Path
import psutil

parser = argparse.ArgumentParser()
parser.add_argument('--parent', type=int, required=True)
parser.add_argument('--state', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
running = True

def stop(*_):
    global running
    running = False

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
args.output.parent.mkdir(parents=True, exist_ok=True)
with args.output.open('w') as output:
    while running:
        sample = {'monotonic': time.monotonic(), 'swap_bytes': psutil.swap_memory().used,
                  'available_bytes': psutil.virtual_memory().available,
                  'browser_rss_bytes': 0, 'gpu_process_rss_bytes': 0, 'native_rss_bytes': 0,
                  'browser_processes': 0, 'errors': []}
        try:
            descendants = psutil.Process(args.parent).children(recursive=True)
            for process in descendants:
                try:
                    name = process.name().lower()
                    if 'chrome' not in name and 'chromium' not in name:
                        continue
                    rss = process.memory_info().rss
                    sample['browser_rss_bytes'] += rss
                    sample['browser_processes'] += 1
                    if any('--type=gpu-process' in part for part in process.cmdline()):
                        sample['gpu_process_rss_bytes'] += rss
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            entries = json.loads((args.state / 'processes.json').read_text())
            seen = set()
            for entry in entries.values():
                if 'pid' not in entry:
                    continue
                try:
                    root = psutil.Process(entry['pid'])
                    for process in [root, *root.children(recursive=True)]:
                        if process.pid not in seen:
                            seen.add(process.pid)
                            sample['native_rss_bytes'] += process.memory_info().rss
                except psutil.NoSuchProcess:
                    sample['errors'].append('native process disappeared')
        except (OSError, ValueError, psutil.Error) as error:
            sample['errors'].append(str(error))
        output.write(json.dumps(sample) + '\n')
        output.flush()
        for _ in range(20):
            if not running:
                break
            time.sleep(.1)
