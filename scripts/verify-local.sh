#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"
if [ "$(uname -s)" != Darwin ]; then
  printf 'Full local verification requires macOS. Run npm run build && npm test for the browser suite.\n' >&2
  exit 1
fi
npm run docs:check
npm run build
npm test
npm run licenses
bash scripts/build-macos.sh
bundle="$project_root/build/TyporaX.app"
"$bundle/Contents/MacOS/TyporaX" --web-smoke-test
"$bundle/Contents/MacOS/TyporaX" --integration-self-test
"$bundle/Contents/MacOS/TyporaX" --pdf-self-test
codesign --verify --deep --strict "$bundle"
bash scripts/package-macos.sh
release_version="$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")"
release_arch="${ARCH:-$(uname -m)}"
release_name="TyporaX-$release_version-macOS-$release_arch.dmg"
hdiutil verify "build/$release_name"
(cd build && shasum -a 256 "$release_name" > SHA256SUMS)
printf 'LOCAL VERIFICATION PASSED: %s\n' "$release_name"
