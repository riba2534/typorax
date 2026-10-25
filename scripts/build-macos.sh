#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
bundle_path="$project_root/build/TyporaX.app"
build_arch="${ARCH:-$(uname -m)}"
case "$build_arch" in arm64|x86_64) ;; *) printf 'Unsupported architecture: %s\n' "$build_arch" >&2; exit 1 ;; esac
if [ ! -f "$project_root/dist/index.html" ]; then
  printf 'Missing dist/index.html. Run npm run build first.\n' >&2
  exit 1
fi
mkdir -p "$bundle_path/Contents/MacOS" "$bundle_path/Contents/Resources"
xcrun swiftc -swift-version 5 -O -target "$build_arch-apple-macosx14.0" \
  -framework AppKit -framework WebKit -framework UniformTypeIdentifiers -framework PDFKit \
  "$project_root/native/FileStore.swift" "$project_root/native/App.swift" \
  "$project_root/native/SelfTests.swift" "$project_root/native/NativeIntegrationTests.swift" "$project_root/native/main.swift" \
  -o "$bundle_path/Contents/MacOS/TyporaX"
cp "$project_root/native/Info.plist" "$bundle_path/Contents/Info.plist"
if [ -d "$bundle_path/Contents/Resources/web" ]; then
  rm -rf "$bundle_path/Contents/Resources/web"
fi
ditto "$project_root/dist" "$bundle_path/Contents/Resources/web"
if [ -f "$project_root/LICENSE" ]; then cp "$project_root/LICENSE" "$bundle_path/Contents/Resources/LICENSE"; fi
if [ -f "$project_root/THIRD_PARTY_NOTICES.md" ]; then cp "$project_root/THIRD_PARTY_NOTICES.md" "$bundle_path/Contents/Resources/THIRD_PARTY_NOTICES.md"; fi
if [ -f "$project_root/scripts/icon.swift" ]; then
  xcrun swift "$project_root/scripts/icon.swift" "$project_root/build/AppIcon.iconset" "$project_root/assets/logo.png"
  iconutil -c icns "$project_root/build/AppIcon.iconset" -o "$bundle_path/Contents/Resources/AppIcon.icns"
fi
codesign --force --sign - "$bundle_path"
"$bundle_path/Contents/MacOS/TyporaX" --self-test
printf 'Built: %s\n' "$bundle_path"
