"""Build a two-minute 1080p session archive from existing, verified local fixtures."""
import argparse
import hashlib
import json
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('--template', type=Path, required=True)
parser.add_argument('--video', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
data = args.template.read_bytes()
assert data[:8] == b'OCBACK01'
length = int.from_bytes(data[8:12], 'little')
assert hashlib.sha256(data[44:44 + length]).digest() == data[12:44]
manifest = json.loads(data[44:44 + length])
cursor = 44 + length
originals = {}
for asset in manifest['assets']:
    original = data[cursor:cursor + asset['size']]
    assert len(original) == asset['size']
    assert [hashlib.sha256(original[i:i + 8 * 1024**2]).hexdigest() for i in range(0, len(original), 8 * 1024**2)] == asset['hashes']
    originals[asset['id']] = original
    cursor += asset['size']
assert cursor == len(data)
video = args.video.read_bytes()
video_asset = next(asset for asset in manifest['assets'] if asset['type'] == 'video')
video_asset.update(name=args.video.name, size=len(video), duration=120, width=1920, height=1080,
                   hashes=[hashlib.sha256(video[i:i + 8 * 1024**2]).hexdigest() for i in range(0, len(video), 8 * 1024**2)])
originals[video_asset['id']] = video
project = manifest['project']
project['metadata'].update(name='Two-minute 1080p mixed session', duration=120)
project['settings']['canvasSize'] = {'width': 1920, 'height': 1080}
for track in project['scenes'][0]['tracks']:
    for element in track['elements']:
        if element['type'] == 'video':
            element.update(duration=118, sourceDuration=120, trimStart=0, trimEnd=2)
        elif element['type'] == 'image':
            element.update(startTime=118, duration=2)
encoded = json.dumps(manifest, separators=(',', ':')).encode()
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_bytes(b'OCBACK01' + len(encoded).to_bytes(4, 'little') + hashlib.sha256(encoded).digest() + encoded + b''.join(originals[asset['id']] for asset in manifest['assets']))
print(json.dumps({'output': str(args.output), 'original_bytes': sum(map(len, originals.values())), 'duration': 120, 'canvas': project['settings']['canvasSize']}))
