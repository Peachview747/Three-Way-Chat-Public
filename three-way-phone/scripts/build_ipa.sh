#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
test "$(uname -s)" = Darwin || { echo "A Mac with Xcode is required for the IPA build."; exit 1; }
python3 scripts/make_icon.py
python3 scripts/prepare_assets.py
cd ios
xcodegen generate
xcodebuild -project ThreeWayPhone.xcodeproj -scheme ThreeWayPhone -configuration Release -destination 'generic/platform=iOS' -archivePath "$ROOT/.build/ThreeWayPhone.xcarchive" CODE_SIGNING_ALLOWED=NO archive
cd "$ROOT"
python3 scripts/package_ipa.py .build/ThreeWayPhone.xcarchive .build/AI-Room-0.1.0-Build-8.ipa
