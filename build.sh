#!/usr/bin/env bash
# Builds the single-file playable ad from TypeScript source.
set -e

npx esbuild src/main.ts --bundle --minify --format=iife --outfile=dist/bundle.js

python3 - <<'PY'
import pathlib
template = pathlib.Path("src/index.template.html").read_text()
bundle = pathlib.Path("dist/bundle.js").read_text()
out = template.replace("/*BUNDLE_PLACEHOLDER*/", bundle)
pathlib.Path("dist/index.html").write_text(out)
print("Built dist/index.html")
PY

# Copy real binary assets alongside the build so libTex/libGlb/libAudio
# paths in assets.ts (e.g. "./assets/textures/coin.png") keep resolving.
# NOTE: for a true single-file ad-network upload, assets must instead be
# base64-inlined — see the "Going fully single-file" section in README.md.
if [ -d assets ]; then
  mkdir -p dist/assets
  cp -r assets/. dist/assets/
  echo "Copied assets/ -> dist/assets/"
fi
