#!/usr/bin/env bash
# Packages the extension into a distributable zip, excluding dev-only files.
# Usage: ./build-zip.sh

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

name=$(grep -m1 '"name"' manifest.json | sed -E 's/.*"name":[[:space:]]*"([^"]+)".*/\1/' | tr '[:upper:] ' '[:lower:]-')
version=$(grep -m1 '"version"' manifest.json | sed -E 's/.*"version":[[:space:]]*"([^"]+)".*/\1/')
out_zip="$root/$name-$version.zip"

rm -f "$out_zip"

zip -r -q "$out_zip" . \
  -x '.git/*' \
  -x '.agents/*' \
  -x 'docs/*' \
  -x 'landing_page/*' \
  -x 'node_modules/*' \
  -x '.vscode/*' \
  -x '.claude/*' \
  -x '*.md' \
  -x '*.zip' \
  -x 'build-zip.sh' \
  -x 'build-zip.ps1'

echo "Created $out_zip"
