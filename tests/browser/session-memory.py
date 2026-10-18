"""Read-only process-tree and host swap sampling for the opt-in browser soak."""
import argparse
import json
import signal
import sys
import time
from pathlib import Path
import psutil

running = True


def stop(*_):
    global running
    running = False


def parent_alive(parent):
    # The captured Process retains its creation identity; is_running also
    # checks PID reuse. A zombie cannot own or collect this sampler anymore.
    try:
        return parent.is_running() and parent.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def collect(parent, state):
    sample = {'monotonic': time.monotonic(), 'swap_bytes': None,
              'available_bytes': None, 'browser_rss_bytes': 0,
              'gpu_process_rss_bytes': 0, 'native_rss_bytes': 0,
              'browser_processes': 0, 'errors': []}
    for field, read in [('swap_bytes', lambda: psutil.swap_memory().used),
                        ('available_bytes', lambda: psutil.virtual_memory().available)]:
        try:
            sample[field] = read()
        except (OSError, psutil.Error) as error:
            sample['errors'].append(f'{field}: {type(error).__name__}: {error}')
    try:
        for process in parent.children(recursive=True):
            try:
                name = process.name().lower()
                if 'chrome' not in name and 'chromium' not in name:
                    continue
                rss = process.memory_info().rss
                sample['browser_rss_bytes'] += rss
                sample['browser_processes'] += 1
                if any('--type=gpu-process' in part for part in process.cmdline()):
                    sample['gpu_process_rss_bytes'] += rss
            except psutil.NoSuchProcess:
                pass
            except (OSError, psutil.Error) as error:
                sample['errors'].append(f'browser process: {type(error).__name__}: {error}')
    except (OSError, psutil.Error) as error:
        sample['errors'].append(f'browser tree: {type(error).__name__}: {error}')
    try:
        entries = json.loads((state / 'processes.json').read_text())
        if not isinstance(entries, dict):
            raise ValueError('Invalid native ownership state')
        required = {'web', 'ai-backend', 'ollama', 'ollama-proxy',
                    'whisper-service', 'tts-service', 'image-service',
                    'speaker-service', 'face-service', 'clip-service',
                    'translate-service', 'media-service'}
        missing = sorted(name for name in required if not isinstance(entries.get(name), dict) or 'pid' not in entries[name])
        if missing:
            sample['errors'].append('native ownership entries missing: ' + ', '.join(missing))
        seen = set()
        for entry in entries.values():
            if not isinstance(entry, dict) or 'pid' not in entry:
                continue
            try:
                root = psutil.Process(entry['pid'])
                if not entry.get('identity') or time.ctime(root.create_time()) != entry['identity']:
                    sample['errors'].append('native process identity changed or unavailable')
                    continue
                for process in [root, *root.children(recursive=True)]:
                    if process.pid not in seen:
                        seen.add(process.pid)
                        sample['native_rss_bytes'] += process.memory_info().rss
            except (OSError, psutil.Error) as error:
                sample['errors'].append(f'native process: {type(error).__name__}: {error}')
    except (OSError, ValueError, TypeError, psutil.Error) as error:
        sample['errors'].append(f'native state: {type(error).__name__}: {error}')
    return sample


def run(parent, state, output_path):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open('w') as output:
        while running and parent_alive(parent):
            output.write(json.dumps(collect(parent, state)) + '\n')
            output.flush()
            for _ in range(20):
                if not running:
                    break
                time.sleep(.1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--parent', type=int, required=True)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        run(psutil.Process(args.parent), args.state, args.output)
    except psutil.NoSuchProcess:
        return 0
    except (OSError, ValueError, psutil.Error) as error:
        print(f'Memory sampler stopped: {type(error).__name__}: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
