"""Live managed-worker upload/disconnect and invalid-trim probe; never delete other assets."""
import argparse
import hashlib
import json
from pathlib import Path
import socket
import time
import httpx
import psutil

ROOT = Path(__file__).resolve().parents[2]


def validate(video, output):
    state = ROOT / '.mac-runtime'
    token = (state / 'token').read_text().strip()
    entry = json.loads((state / 'processes.json').read_text())['media-service']
    worker = psutil.Process(entry['pid'])
    base = 'http://127.0.0.1:8428'
    headers = {'Authorization': f'Bearer {token}'}
    asset = None
    report = {'passed': False, 'worker_pid': worker.pid, 'media_implementation_sha256': hashlib.sha256((ROOT / 'services/media-service/app.py').read_bytes()).hexdigest()}
    try:
        with httpx.Client(headers=headers, timeout=60) as client:
            client.get(base + '/health').raise_for_status()
            capability = client.get(base + '/capabilities'); capability.raise_for_status()
            if not capability.json()['hardware_available']:
                raise RuntimeError('VideoToolbox unavailable; numeric trim command validation not established')
            files_before = set((state / 'media').iterdir())
            baseline = worker.num_fds()
            boundary = 'opencut-owned-disconnect-probe'
            prefix = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.mp4"\r\nContent-Type: video/mp4\r\n\r\n').encode()
            suffix = f'\r\n--{boundary}--\r\n'.encode()
            content_length = len(prefix) + video.stat().st_size + len(suffix)
            sock = socket.create_connection(('127.0.0.1', 8428), timeout=10)
            try:
                request = f'POST /assets HTTP/1.1\r\nHost: 127.0.0.1:8428\r\nAuthorization: Bearer {token}\r\nContent-Type: multipart/form-data; boundary={boundary}\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n'
                sock.sendall(request.encode() + prefix)
                with video.open('rb') as source:
                    partial = source.read(2 * 1024**2)
                if len(partial) < 2 * 1024**2: raise ValueError('Use a fixture larger than two MiB')
                sock.sendall(partial)
                deadline = time.monotonic() + 10
                peak = worker.num_fds()
                while time.monotonic() < deadline:
                    client.get(base + '/health').raise_for_status()
                    peak = max(peak, worker.num_fds())
                    if peak >= baseline + 2: break
                    time.sleep(.02)
                if peak < baseline + 2: raise RuntimeError('Did not observe both accepted socket and rolled multipart spool')
                report.update(baseline_fds=baseline, partial_upload_peak_fds=peak)
            finally:
                sock.close()
            deadline = time.monotonic() + 10
            while worker.num_fds() > baseline and time.monotonic() < deadline:
                # Keep the baseline HTTP connection alive: its expiry must not
                # hide a leaked descriptor from the interrupted upload.
                client.get(base + '/health').raise_for_status()
                time.sleep(.05)
            report['fds_after_disconnect'] = worker.num_fds()
            report['disconnect_released_descriptors'] = report['fds_after_disconnect'] <= baseline
            report['disconnect_left_no_assets'] = set((state / 'media').iterdir()) == files_before
            with video.open('rb') as source:
                response = client.post(base + '/assets', files={'file': (video.name, source, 'video/mp4')})
            response.raise_for_status(); asset = response.json()['asset_id']
            report['normal_upload_bytes'] = response.json()['size']
            results = []
            for value in ['"inf"', '1e309', '1e308']:
                payload = '{"clips":[{"asset_id":"' + asset + '","duration":1,"start":' + value + '}]}'
                response = client.post(base + '/jobs', content=payload, headers={'Content-Type': 'application/json'})
                results.append({'input': value, 'http': response.status_code, 'detail_is_json': isinstance(response.json().get('detail'), (str, list))})
            report['invalid_trim_checks'] = results
            report['passed'] = report['disconnect_released_descriptors'] and report['disconnect_left_no_assets'] and all(result['http'] == 422 and result['detail_is_json'] for result in results)
            if not report['passed']: raise RuntimeError('Live upload/trim checks failed; inspect report')
    except BaseException as error:
        report['error'] = str(error)
        raise
    finally:
        cleanup_error = None
        if asset:
            try:
                with httpx.Client(headers=headers, timeout=30) as client:
                    client.delete(base + '/assets/' + asset).raise_for_status()
            except Exception as error:
                cleanup_error = error
                report['cleanup_error'] = str(error)
                report['passed'] = False
        report['limitations'] = ['Descriptor count observes retained socket/spool lifetime; isolated ASGI tests verify exact spool handles and body-limit/cancellation paths', 'No two-GiB live overflow upload; body-limit413 covered with bounded isolated fixtures', 'Native worker only, not browser project storage or timeline parity']
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + '\n')
        if cleanup_error and 'error' not in report:
            raise RuntimeError('Probe asset cleanup failed; inspect report') from cleanup_error
    print('Live interrupted upload cleanup, normal upload and invalid trim validation passed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--video', type=Path, default=ROOT.parent / 'validation/fixtures/editor-smoke-8s.mp4')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    validate(args.video.resolve(strict=True), args.report)
