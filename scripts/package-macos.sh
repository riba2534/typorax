#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
bundle_path="$project_root/build/TyporaX.app"
release_arch="${ARCH:-$(uname -m)}"
version="$(cd "$project_root" && node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")"
if [ ! -d "$bundle_path" ]; then
  printf 'Build TyporaX.app first with npm run build:mac.\n' >&2
  exit 1
fi
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/typorax-package.XXXXXX")"
trap 'rm -rf "$stage_dir"' EXIT
ditto "$bundle_path" "$stage_dir/TyporaX.app"
ln -s /Applications "$stage_dir/Applications"
image_path="$project_root/build/TyporaX-$version-macOS-$release_arch.dmg"
hdiutil create -volname TyporaX -srcfolder "$stage_dir" -ov -format UDZO "$image_path"
printf 'Packaged: %s\n' "$image_path"
