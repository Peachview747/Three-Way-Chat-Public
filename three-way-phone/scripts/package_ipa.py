"""Validate and package a device archive for personal sideload signing."""
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import sys
import zipfile

archive, output = map(Path, sys.argv[1:])
app = archive / 'Products/Applications/ThreeWayPhone.app'
with (app / 'Info.plist').open('rb') as handle:
    info = plistlib.load(handle)
assert info['CFBundleIdentifier'] == 'com.peachview.threeway.phone'
assert info['CFBundleVersion'] == '1'
assert info['CFBundleShortVersionString'] == '0.1.0'
assert not info.get('UIBackgroundModes'), 'Chat must not use media background modes.'
assert info.get('MinimumOSVersion') == '17.0'
for asset in ['index.html', 'style.css', 'app.js']:
    assert (app / 'Dashboard' / asset).is_file(), 'Missing bundled dashboard: ' + asset
binary = app / info['CFBundleExecutable']
magic, cpu = struct.unpack('<II', binary.read_bytes()[:8])
assert magic == 0xfeedfacf and cpu == 0x0100000c, 'Expected a device arm64 Mach-O executable.'
subprocess.run(['codesign', '--force', '--sign', '-', '--timestamp=none', str(app)], check=True)
subprocess.run(['codesign', '--verify', '--strict', str(app)], check=True)
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as package:
    for path in sorted(app.rglob('*')):
        if path.is_file():
            package.write(path, 'Payload/ThreeWayPhone.app/' + path.relative_to(app).as_posix())
with zipfile.ZipFile(output) as package:
    assert package.testzip() is None
    assert 'Payload/ThreeWayPhone.app/Info.plist' in package.namelist()
sha = hashlib.sha256(output.read_bytes()).hexdigest()
report = {'file': output.name, 'sha256': sha, 'bundle': info['CFBundleIdentifier'], 'version': '0.1.0', 'build': 1, 'signing': 'ad-hoc template; personal sideload signing required'}
output.with_suffix('.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
