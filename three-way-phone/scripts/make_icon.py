"""Dependency-free opaque PNG icon, separate from Video Pilot's icon."""
from pathlib import Path
import json
import struct
import zlib

size = 1024
pixels = bytearray()
circles = [(340, 390, 130, (89, 126, 112)), (684, 390, 130, (119, 134, 159)), (512, 670, 130, (173, 131, 108))]
for y in range(size):
    pixels.append(0)
    for x in range(size):
        v = int(242 - y * 28 / size)
        color = (v, min(255, v + 2), min(255, v + 5))
        for cx, cy, radius, ink in circles:
            distance = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            blend = max(0.0, min(1.0, radius - distance + 0.5))
            if blend:
                color = tuple(round(a * (1 - blend) + b * blend) for a, b in zip(color, ink))
        pixels.extend(color)

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

root = Path(__file__).resolve().parents[1] / 'ios' / 'Assets.xcassets'
target = root / 'AppIcon.appiconset'
target.mkdir(parents=True, exist_ok=True)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels, 9)) + chunk(b'IEND', b'')
(target / 'AppIcon.png').write_bytes(png)
(root / 'Contents.json').write_text(json.dumps({'info': {'author': 'xcode', 'version': 1}}))
(target / 'Contents.json').write_text(json.dumps({'images': [{'filename': 'AppIcon.png', 'idiom': 'universal', 'platform': 'ios', 'size': '1024x1024'}], 'info': {'author': 'xcode', 'version': 1}}))
