#!/usr/bin/env bash
# Build the portable Windows zip without Windows, Wine or npm.
# Needs: bash, curl, unzip, zip, python3 (numpy optional).
# usage: tools/build-portable.sh [electron-version]   e.g. tools/build-portable.sh 44.9.2
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EV="${1:-44.9.2}"
VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")"
WORK="$ROOT/build"
OUT="$ROOT/dist"
ZIP="electron-v$EV-win32-x64.zip"
mkdir -p "$WORK" "$OUT"

if [ ! -f "$WORK/$ZIP" ]; then
  curl -fL -o "$WORK/$ZIP" "https://github.com/electron/electron/releases/download/v$EV/$ZIP"
  curl -fL -o "$WORK/SHASUMS256.txt" "https://github.com/electron/electron/releases/download/v$EV/SHASUMS256.txt"
  (cd "$WORK" && grep " \*$ZIP\$" SHASUMS256.txt | sed 's/ \*/  /' | sha256sum -c -)
fi

APP="$WORK/Soundfast"
rm -rf "$APP" && mkdir -p "$APP"
unzip -q "$WORK/$ZIP" -d "$APP"
rm -f "$APP/resources/default_app.asar"
mkdir -p "$APP/resources/app"
cp -r "$ROOT/package.json" "$ROOT/src" "$ROOT/assets" "$APP/resources/app/"
rm -f "$APP/resources/app/assets/icon-1024.png"
python3 "$ROOT/tools/rcpatch.py" "$APP/electron.exe" "$APP/Soundfast.exe" "$ROOT/assets/icon.ico" \
  --version "$VERSION" --name Soundfast --description Soundfast \
  --company "Soundfast contributors" --copyright "MIT License"
rm "$APP/electron.exe"
cp "$ROOT/LICENSE" "$APP/LICENSE.soundfast.txt"

rm -f "$OUT/Soundfast-$VERSION-win-x64.zip"
(cd "$WORK" && zip -qr -9 "$OUT/Soundfast-$VERSION-win-x64.zip" Soundfast)
echo "Built $OUT/Soundfast-$VERSION-win-x64.zip"
