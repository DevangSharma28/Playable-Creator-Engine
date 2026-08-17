#!/usr/bin/env bash
# Builds the single-file playable ad from TypeScript source. The output,
# dist/index.html, is meant to be genuinely self-contained — no dist/assets
# folder, no relative paths, nothing else to upload — so it works opened
# directly (file://) and on any ad network that only accepts one file.
set -e

npx esbuild src/main.ts --bundle --minify --format=iife --outfile=dist/bundle.js

# Inline every "./assets/..." path the bundle references (from assets.ts —
# the only place such paths originate) as a base64 data: URI, replacing the
# path string in place. AssetLoader's THREE.js loaders (TextureLoader,
# GLTFLoader, audio) accept a data URI exactly like a file path, so nothing
# on the loading side needs to know the difference. Anything not actually
# under assets/ is left untouched rather than erroring — a manifest entry
# that doesn't resolve to a real file is a pre-existing bug this step isn't
# responsible for catching.
python3 - <<'PY'
import base64
import mimetypes
import pathlib
import re

bundle_path = pathlib.Path("dist/bundle.js")
bundle = bundle_path.read_text()

# mimetypes doesn't know these; everything else falls back to its own guess.
MIME_OVERRIDES = {
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
}

inlined = []

def inline_one(match):
    quote, rel = match.group(1), match.group(2)
    file_path = pathlib.Path(rel[2:])  # strip leading "./"
    if not file_path.is_file():
        return match.group(0)
    data = file_path.read_bytes()
    mime = MIME_OVERRIDES.get(file_path.suffix.lower()) or mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    b64 = base64.b64encode(data).decode("ascii")
    inlined.append((rel, len(data)))
    return quote + "data:" + mime + ";base64," + b64 + quote

bundle = re.sub(r'(["\'])(\./assets/[^"\']+)\1', inline_one, bundle)
bundle_path.write_text(bundle)

if inlined:
    for rel, size in inlined:
        print(f"Inlined {rel} ({size:,} bytes)")
else:
    print("No ./assets/ paths found to inline")
PY

python3 - <<'PY'
import pathlib
template = pathlib.Path("src/index.template.html").read_text()
bundle = pathlib.Path("dist/bundle.js").read_text()
out = template.replace("/*BUNDLE_PLACEHOLDER*/", bundle)
pathlib.Path("dist/index.html").write_text(out)

size = len(out.encode("utf-8"))
print(f"Built dist/index.html ({size:,} bytes)")
print(f"BUILD_SIZE_BYTES={size}")
PY

# No dist/assets/ copy step — every real asset is inlined into
# dist/index.html above, so there's nothing left to copy alongside it.

# Some ad-network upload flows (Mintegral's Mindworks review among them —
# see https://www.playturbo.com/review/doc) want a .zip rather than a raw
# .html, with the zip/HTML file names matching. Best-effort: skip quietly
# if `zip` isn't installed rather than failing the whole build over a
# packaging nicety — dist/index.html itself is always the real output.
if command -v zip >/dev/null 2>&1; then
  ( cd dist && zip -q -j index.zip index.html )
  echo "Zipped dist/index.zip (dist/index.html only, no assets folder needed)"
else
  echo "zip not found — skipping dist/index.zip (dist/index.html is still the complete, self-contained output)"
fi
