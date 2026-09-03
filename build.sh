#!/usr/bin/env bash
# Builds the single-file playable ad from TypeScript source. The output,
# dist/index.html, is meant to be genuinely self-contained — no dist/assets
# folder, no relative paths, nothing else to upload — so it works opened
# directly (file://) and on any ad network that only accepts one file.
#
# Vite (via vite.config.prod.ts + vite-plugin-singlefile) bundles+minifies
# src/main.ts and everything it imports (Three.js, mainLayout.json,
# bindings.json, ...) and inlines it directly into src/index.template.html
# — a genuinely different, dev-chrome-free entry than the dev preview's
# own index.html (see vite.config.prod.ts's own doc comment for why
# there are two). Vite's own module graph never sees this project's real
# game assets (GLB models, textures) though — assets.ts references them
# as plain runtime string paths for AssetLoader/THREE's own loaders to
# fetch, not `import` statements — so the python step below inlines those
# the same way this build always has, just retargeted at Vite's output
# HTML instead of esbuild's intermediate bundle.js.
set -e

# The two external programs this pipeline needs beyond Node. Checked up front
# with a message that says what to install, because the alternative is
# "python3: command not found" arriving several minutes into a build, from a
# heredoc, with no indication that it was a prerequisite. (`zip` is checked at
# the point of use instead — it is a packaging nicety and its absence only
# skips one optional artifact.)
if ! command -v python3 >/dev/null 2>&1; then
  echo "✖ python3 is required to build an ION project but was not found on PATH." >&2
  echo "  It performs the asset-inlining and build-report steps." >&2
  echo "  macOS:  it ships with the Xcode command line tools (xcode-select --install)" >&2
  echo "  Linux:  apt install python3   /   dnf install python3" >&2
  echo "  Windows: install Python 3 from python.org and build from Git Bash or WSL" >&2
  exit 1
fi

# Bash's own auto-incrementing elapsed-seconds counter — read again near the
# end for the Build Report's "how long did this take" figure. Reset to 0
# here (not relied on being 0 already) so a re-sourced/nested invocation
# still times just this build.
SECONDS=0

# Where this pipeline's own helpers live, and which Vite config to build with.
# Unset means "this repository" — ION's own development mode, unchanged. The
# `ion build` command sets both to @ion-engine/build's installed lib/ so a
# customer project runs this exact script without a copy of it in their tree.
: "${ION_BUILD_LIB:=scripts}"
: "${ION_VITE_CONFIG:=vite.config.prod.mts}"

# Stash the outgoing build report before anything can delete it.
#
# The report block at the end wants the *previous* build's sizes, so it can
# say "+18 KB since last build" - the one question a size budget actually
# gets asked. It cannot just read dist/build-report.json at that point,
# because by then two separate steps have destroyed it:
#
#   - vite.config.prod.mts sets `emptyOutDir: true`, so Vite wipes dist/.
#   - compress-assets.mjs deletes .build-cache/ before repopulating it,
#     which rules out the one directory that otherwise outlives a build.
#
# So it goes somewhere neither of them can reach: a temp file owned by this
# invocation, removed on the way out.
ION_PREV_REPORT=""
if [ -f dist/build-report.json ]; then
  ION_PREV_REPORT="$(mktemp -t ion-prev-report)"
  cp dist/build-report.json "$ION_PREV_REPORT"
fi
export ION_PREV_REPORT


# Compresses assets/models/*.glb and assets/sounds/*.ogg into .build-cache/
# — never touches assets/ itself. HALF_FLOAT (set by the Builder panel's
# checkbox via scripts/dev-build-api.js; defaults to on here for a plain
# `npm run build`) picks meshopt vs. quantize-only geometry compression —
# see scripts/compress-assets.mjs's own doc comment for what each does and
# why flatten/join/instance/simplify are deliberately never applied. This
# step is a size optimization, not a build requirement, so a failure here
# (missing devDependency, no ffmpeg, ...) only warns — the inline step
# below falls back to the real assets/ files for anything the cache is
# missing, same as it always has.
node "${ION_BUILD_LIB:-scripts}/compress-assets.mjs"

npx vite build --config "${ION_VITE_CONFIG:-vite.config.prod.mts}"

# vite-plugin-singlefile names its output after the input HTML's own
# basename (src/index.template.html), landing at dist/index.template.html
# — rename to the real production filename.
mv dist/index.template.html dist/index.html

# Strips type="module"/crossorigin off the inlined <script> tag and moves
# it to just before </body>. The JS itself already has zero import/export
# left in it — vite.config.prod.mts sets rollupOptions.output.format:"iife"
# specifically so Rollup fully inlines everything into one self-executing
# classic script — but Vite's HTML-entry build always wraps an HTML
# input's own script ref in type="module" regardless of that output format
# (a known Vite limitation: format only controls the JS chunk's own
# syntax, not how an HTML-entry build tags the <script> that loads it), so
# the tag itself still needs a manual fix here. Left as type="module", the
# file fails ad-network review outright — Mintegral's Mindworks flags it
# by name ("Do not use crossorigin, type='module', import or export in
# local files") — because some review WebViews don't support ES modules at
# all, and file:// blocks module script loading via CORS regardless of
# WebView support.
#
# Moved to end of <body>, not just detagged in place: vite-plugin-singlefile
# hoists the inlined script into <head>, ahead of <body>'s own #game
# canvas — module scripts are implicitly deferred (run only after the
# document finishes parsing) regardless of where they sit, which is what
# let this work from <head> at all before. A classic script has no such
# deferral (and `defer` is spec-defined to do nothing for an *inline*
# script — only for one with a src to fetch), so left in <head> it ran
# immediately, before #game existed: `document.getElementById("game")` was
# null, and `new THREE.WebGLRenderer({canvas: null})` threw reading
# `canvas.width` — exactly the regression that caught this the first time
# this step was written as a simple type="module" strip. Relocating the
# script to the end of <body> (where src/index.template.html's own
# `<script type="module" src="./main.ts">` already sat, before Vite ever
# touched it) restores the same "DOM's already there" guarantee without
# needing any deferral mechanism at all.
python3 - <<'PY'
import pathlib
import re

html_path = pathlib.Path("dist/index.html")
html = html_path.read_text()

m = re.search(r'<script\s+type="module"\s+crossorigin(?:\s+src="[^"]*")?>.*?</script>', html, re.S)
if m:
    script_tag = m.group(0)
    script_tag = re.sub(r'^<script\s+type="module"\s+crossorigin(\s+src="[^"]*")?>', lambda mm: "<script" + (mm.group(1) or "") + ">", script_tag)
    html = html[: m.start()] + html[m.end() :]
    html = html.replace("</body>", script_tag + "\n</body>")

html_path.write_text(html)
PY

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

html_path = pathlib.Path("dist/index.html")
html = html_path.read_text()

# mimetypes doesn't know these; everything else falls back to its own guess.
MIME_OVERRIDES = {
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
}

inlined = []

def inline_one(match):
    quote, rel = match.group(1), match.group(2)
    file_path = pathlib.Path(rel[2:])  # strip leading "./"
    # Prefer the compressed copy scripts/compress-assets.mjs wrote above,
    # mirroring assets/'s own layout under .build-cache/ — falls back to
    # the real assets/ file untouched when compression skipped this one
    # (unsupported extension, or the compression step failed/was never
    # run), so this inlines something correct either way.
    if file_path.is_relative_to("assets"):
        cached = pathlib.Path(".build-cache") / file_path.relative_to("assets")
        if cached.is_file():
            file_path = cached
    if not file_path.is_file():
        return match.group(0)
    data = file_path.read_bytes()
    mime = MIME_OVERRIDES.get(file_path.suffix.lower()) or mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    b64 = base64.b64encode(data).decode("ascii")
    inlined.append({"relPath": rel[2:], "sourceBytes": len(data), "inlinedBytes": len(quote + "data:" + mime + ";base64," + b64 + quote)})
    return quote + "data:" + mime + ";base64," + b64 + quote

# Vite's minifier (esbuild under the hood) sometimes emits a plain string
# literal as a backtick template literal instead of "/' — quote-agnostic
# here so either form gets inlined the same way.
html = re.sub(r'(["\'`])(\./assets/[^"\'`]+)\1', inline_one, html)
html_path.write_text(html)

if inlined:
    for item in inlined:
        print(f"Inlined {item['relPath']} ({item['sourceBytes']:,} bytes)")
else:
    print("No ./assets/ paths found to inline")

# Handed to the Build Report step below (a separate python3 invocation, so
# no shared state) — deleted there once merged into dist/build-report.json.
import json
pathlib.Path("dist/.inline-manifest.json").write_text(json.dumps(inlined))
PY

python3 - <<'PY'
import pathlib
size = pathlib.Path("dist/index.html").stat().st_size
print(f"Built dist/index.html ({size:,} bytes)")
print(f"BUILD_SIZE_BYTES={size}")
PY

# dist/build-report.json — merges scripts/compress-assets.mjs's per-asset
# compression + inspect() detail (.build-cache/report.json) with the exact
# final base64-inlined size of each (dist/.inline-manifest.json, written
# above) and whole-build numbers (total size, gzip size, budget, duration).
# A dev artifact alongside dist/index.html, not inlined into it — read by
# GET /build-report (scripts/dev-build-api.js) for the Builder panel's
# "📊 Build Report" button. Best-effort, same reasoning as the compression
# step itself: a missing/malformed .build-cache/report.json (compression
# was skipped or failed) shouldn't fail the whole build over a report file.
BUILD_DURATION_S="$SECONDS" python3 - <<'PY'
import datetime
import gzip
import json
import os
import pathlib

BUDGET_BYTES = int(os.environ.get("ION_BUDGET_BYTES") or 5 * 1024 * 1024)

try:
    compress_report = json.loads(pathlib.Path(".build-cache/report.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    compress_report = {"halfFloat": None, "assets": [], "unusedAssets": []}

inline_manifest_path = pathlib.Path("dist/.inline-manifest.json")
try:
    inlined_by_path = {item["relPath"]: item for item in json.loads(inline_manifest_path.read_text())}
except (FileNotFoundError, json.JSONDecodeError):
    inlined_by_path = {}
inline_manifest_path.unlink(missing_ok=True)

for asset in compress_report["assets"]:
    inlined = inlined_by_path.get(asset["relPath"])
    asset["inlinedBytes"] = inlined["inlinedBytes"] if inlined else None

html_bytes = pathlib.Path("dist/index.html").read_bytes()
dist_bytes = len(html_bytes)
gzip_bytes = len(gzip.compress(html_bytes, compresslevel=9))

# The ad-network compatibility gate lives in scripts/compat-scan.mjs (shipped
# as @ion-engine/build's lib/compat-scan.mjs) rather than inline here, so its
# rules can be unit tested against the patterns they claim to catch — see
# tests/compat-scan.test.mjs. It also strips inlined base64 asset payloads
# before matching, which the inline version did not: the base64 alphabet
# produces sequences like "16n" freely, and a gate that reports imaginary
# BigInt literals in a clean bundle is a gate people learn to ignore.
import subprocess

scan = subprocess.run(
    ["node", os.path.join(os.environ.get("ION_BUILD_LIB", "scripts"), "compat-scan.mjs"), "dist/index.html", "--json"],
    capture_output=True,
    text=True,
)
try:
    findings = json.loads(scan.stdout or "[]")
except json.JSONDecodeError:
    findings = []
    print(f"\u26a0 The compatibility scan could not be run ({scan.stderr.strip() or 'no output'}) \u2014 treating the build as unscanned.")

compatibility_warnings = [
    f"{f['label']}: {f['count']} occurrence(s) [{f['since']}]. {f['breaks']} {f['hint']}"
    for f in findings
]
if compatibility_warnings:
    print("\n\u26a0 Ad-network compatibility warnings found in dist/index.html:")
    for w in compatibility_warnings:
        print(f"  - {w}")
    print("These patterns are known to fail ad-network review (Mintegral's Mindworks among them) \u2014 see dist/build-report.json's compatibilityWarnings.\n")
else:
    print("\u2713 No known ad-network compatibility issues found (no ES-module syntax, no ES2019+ syntax, no post-ES2018 runtime APIs).")

# The report that is about to be replaced, read before it is — this is what
# lets the Builder answer "did my change make it bigger?", which is the one
# question a size budget actually gets asked. Only the three numbers worth
# comparing are carried forward, so the file cannot grow a chain of every
# build ever run.
report_path = pathlib.Path("dist/build-report.json")
previous_path = os.environ.get("ION_PREV_REPORT") or ""
try:
    _prev = json.loads(pathlib.Path(previous_path).read_text())
    previous = {
        "builtAt": _prev.get("builtAt") or _prev.get("generatedAt"),
        "distBytes": _prev.get("distBytes"),
        "gzipBytes": _prev.get("gzipBytes"),
    }
    # A report with no size in it compares to nothing.
    if previous["distBytes"] is None:
        previous = None
except (FileNotFoundError, json.JSONDecodeError, AttributeError, OSError):
    previous = None

report = {
    # When the *build* finished. Distinct from generatedAt below, which is
    # when the assets were compressed — an earlier moment, and absent
    # entirely when the compression step was skipped or failed, which is
    # exactly when a "last build" readout must still work.
    "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "generatedAt": compress_report.get("generatedAt"),
    "halfFloat": compress_report.get("halfFloat"),
    "buildDurationSec": int(os.environ.get("BUILD_DURATION_S", "0")),
    "distBytes": dist_bytes,
    "gzipBytes": gzip_bytes,
    "budgetBytes": BUDGET_BYTES,
    "overBudget": dist_bytes > BUDGET_BYTES,
    "previous": previous,
    "assets": compress_report["assets"],
    "unusedAssets": compress_report.get("unusedAssets", []),
    "compatibilityWarnings": compatibility_warnings,
}
report_path.write_text(json.dumps(report, indent=2))
print(f"Wrote dist/build-report.json ({dist_bytes:,} bytes dist, {gzip_bytes:,} bytes gzipped)")
PY

# The stash has been folded into the new report; nothing else reads it.
[ -n "$ION_PREV_REPORT" ] && rm -f "$ION_PREV_REPORT"

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

# The submittability gate. Deliberately the very last step, after
# dist/index.html, dist/build-report.json and dist/index.zip have all been
# written: a build that fails this still leaves a complete, inspectable
# artifact on disk. You get the non-zero exit code *and* the output to look
# at, which is usually how you work out what caused the finding.
#
# It fails on two things, both already computed by the python block above:
#   - a non-empty compatibilityWarnings — every pattern in there is supposed
#     to be impossible given vite.config.prod.mts's format:"iife" /
#     target:"es2015", so a hit means one of those regressed (most likely via
#     a dependency upgrade) and the build will bounce at ad-network review
#   - overBudget — the Builder panel has drawn that budget bar since it
#     existed, and until now nothing enforced it
#
# Exit code 2 specifically means "built, but not submittable" (1 would mean
# the check itself couldn't run) — scripts/dev-build-api.js branches on that
# so the Builder panel can still show the real size figures while flagging
# the build red. See scripts/check-build-report.mjs's own header.
#
# Escape hatch, for when you genuinely want the artifact anyway:
#   ALLOW_COMPAT_WARNINGS=1 npm run build
node "${ION_BUILD_LIB:-scripts}/check-build-report.mjs"
