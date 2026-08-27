#!/usr/bin/env node
// Production-build asset compression: shrinks assets/models/*.glb and
// assets/sounds/*.ogg into .build-cache/ before build.sh base64-inlines
// them into dist/index.html. Never touches assets/ itself — the source
// files stay exactly as authored; only the build-only cache changes.
//
// Also writes .build-cache/report.json — per-asset before/after sizes plus
// (for GLBs) a full glTF-Transform inspect() report: mesh/vertex/triangle
// counts, material+texture usage (with GPU memory estimates), animation
// stats. build.sh's own report step (see its final python block) adds the
// final base64-inlined sizes, total dist/index.html size, and gzip size,
// then writes the merged result to dist/build-report.json — what the
// Builder panel's "📊 Build Report" button reads.
//
// .mjs, not .js: @gltf-transform/* and meshoptimizer are ESM-only, and
// this project's other scripts/ files are plain CommonJS (no "type":
// "module" in package.json) — an .mjs extension opts just this one file
// into ESM without touching how the rest of scripts/ loads.
//
// HALF_FLOAT env var (set by the Builder panel's checkbox via
// dev-build-api.js, or by hand for a plain `npm run build`): "0" uses
// KHR_mesh_quantization alone (quantize — compact 16-bit-equivalent
// vertex precision, zero extra runtime decoder, natively supported by
// GLTFLoader); anything else (including unset, so a bare `npm run build`
// still gets the best result) additionally applies EXT_meshopt_compression
// (meshopt — entropy-coded on top of the same quantization, meaningfully
// smaller again) via three.js's own inlined-WASM MeshoptDecoder (see
// AssetLoader.ts's constructor) — no separately-hosted .wasm file, so it
// stays compatible with the single-file playable output. Both modes are
// visually lossless: quantization bounds are computed per-mesh, not
// against the whole (much larger) Cinema_World.glb scene, so precision
// never depends on how sprawling the loaded environment is.
//
// Geometry transforms are deliberately narrow: no flatten/join/instance/
// palette/simplify. Those restructure or merge nodes (or decimate
// triangles), and this project's own game code (Game.ts's
// getObjectByName("walkablearea"/"cinemafloor"/"Colliders"), plus a large
// set of named gameplay anchor points already sitting unused in
// Cinema_World.glb — spawn points, money-collect points, NPC slots —
// clearly meant to be looked up by name later) depends on every node
// keeping its exact name and position in the scene graph. prune() is
// scoped the same way: keepLeaves:true so those empty anchor nodes survive
// — verified against the real file before this script was written; a
// default-options prune() silently deleted 59 of them.

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, weld, resample, sparse, prune, textureCompress, quantize, meshopt, inspect } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";
import sharp from "sharp";

/**
 * The project being built.
 *
 * `ION_PROJECT_ROOT` is set by `ion build` (see packages/project/lib/build.mjs)
 * and is the only correct answer for a customer project: this script is
 * installed at node_modules/@ion-engine/build/lib/, so resolving relative to
 * its own location pointed at the *package* and every path below missed by a
 * mile. The result was an ENOENT on the very first read, a warning, and a
 * build that silently shipped uncompressed textures and un-quantized meshes.
 *
 * The script-relative fallback is ION's own repository, where this file lives
 * in scripts/ and the project root really is one level up.
 */
const ROOT = process.env.ION_PROJECT_ROOT || fileURLToPath(new URL("..", import.meta.url));
const MODELS_SRC = path.join(ROOT, "assets", "models");
const SOUNDS_SRC = path.join(ROOT, "assets", "sounds");
const CACHE = path.join(ROOT, ".build-cache");
const ASSETS_TS = path.join(ROOT, "src", "game", "assets.ts");
const halfFloat = process.env.HALF_FLOAT !== "0";

// A project with no assets is a perfectly normal project — the generated
// starter has none. Say so and stop, rather than failing on a missing
// directory and leaving "compression failed" in the log of a clean build.
if (!fs.existsSync(ASSETS_TS)) {
  console.log(`  No ${path.relative(ROOT, ASSETS_TS)} — nothing to compress.`);
  process.exit(0);
}
if (!fs.existsSync(MODELS_SRC) && !fs.existsSync(SOUNDS_SRC)) {
  console.log("  No assets/models or assets/sounds — nothing to compress.");
  process.exit(0);
}

/**
 * Which files under assets/ are actually loaded by the game — read straight
 * from src/game/assets.ts's own string literals (`"./assets/…"`), the same
 * lightweight regex-scan-the-source approach scripts/dev-build-api.js
 * already uses for Control Desk's script introspection, rather than
 * transpiling/importing the .ts file into this plain Node script.
 *
 * Compressing (and reporting on) only these, not everything sitting in
 * assets/models|sounds/, matters for a real reason found while testing
 * this exact script: swap which file libAudio.MainMusic points at (say,
 * from MainMusic.ogg to a new BG.ogg) and the *old* MainMusic.ogg doesn't
 * go anywhere — it's still sitting on disk, unreferenced. A directory-walk
 * compressor would keep compressing it and — worse — keep listing it in
 * the Build Report's size composition and "largest asset" tip as if it
 * were still part of the shipped build, when dist/index.html no longer
 * embeds a single byte of it. Anything found on disk but not in this set
 * is reported once, separately, as a cleanup opportunity (see
 * `unusedAssets` in run()) instead of silently compressed and confused
 * with what's actually shipped.
 */
function getManifestPaths() {
  const src = fs.readFileSync(ASSETS_TS, "utf8");
  const paths = new Set();
  for (const m of src.matchAll(/\.\/assets\/[^"'`]+/g)) paths.add(m[0].slice(2)); // strip "./"
  return paths;
}

function fmtBytes(n) {
  return n >= 1024 * 1024 ? (n / (1024 * 1024)).toFixed(2) + " MB" : (n / 1024).toFixed(1) + " KB";
}

function reportRow(label, before, after) {
  const pct = before > 0 ? (((before - after) / before) * 100).toFixed(1) : "0.0";
  console.log(`  ${label}: ${fmtBytes(before)} -> ${fmtBytes(after)} (-${pct}%)`);
  return pct;
}

/** Copies the original file into the cache byte-for-byte — the fallback whenever real compression isn't possible, so build.sh's own "prefer .build-cache/" lookup always finds something without needing to know why. */
function copyThrough(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Trims inspect()'s report down to what the Build Report panel actually shows — the raw report also carries per-property `errors`/`warnings` arrays (always empty here, glTF-Transform's own validation, not ours) that would just be dead weight in report.json. */
function summarizeInspect(full) {
  return {
    scenes: full.scenes.properties.map((s) => ({ name: s.name, bboxMin: s.bboxMin, bboxMax: s.bboxMax, renderVertexCount: s.renderVertexCount, uploadVertexCount: s.uploadVertexCount })),
    meshes: full.meshes.properties.map((m) => ({ name: m.name, meshPrimitives: m.meshPrimitives, vertices: m.vertices, glPrimitives: m.glPrimitives, instances: m.instances, size: m.size })),
    materials: full.materials.properties.map((m) => ({ name: m.name, instances: m.instances, textures: m.textures, alphaMode: m.alphaMode, doubleSided: m.doubleSided })),
    textures: full.textures.properties.map((t) => ({ name: t.name, slots: t.slots, instances: t.instances, mimeType: t.mimeType, resolution: t.resolution, size: t.size, gpuSize: t.gpuSize })),
    animations: full.animations.properties.map((a) => ({ name: a.name, channels: a.channels, keyframes: a.keyframes, duration: a.duration, size: a.size })),
  };
}

async function compressGlb(src, dest) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "meshopt.decoder": MeshoptDecoder,
    "meshopt.encoder": MeshoptEncoder,
  });
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;

  const doc = await io.read(src);
  const before = summarizeInspect(inspect(doc));

  await doc.transform(
    dedup(),
    weld(),
    resample(),
    prune({ keepLeaves: true }),
    sparse(),
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [2048, 2048] }),
    halfFloat ? meshopt({ encoder: MeshoptEncoder, level: "high" }) : quantize()
  );

  const after = summarizeInspect(inspect(doc));

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await io.write(dest, doc);

  return { before, after };
}

function probeAudio(file) {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,bit_rate:stream=channels,sample_rate", "-of", "json", file], { stdio: ["ignore", "pipe", "pipe"] }).toString();
    const data = JSON.parse(out);
    const stream = (data.streams && data.streams[0]) || {};
    return {
      durationSec: data.format ? Number(data.format.duration) : null,
      bitRate: data.format ? Number(data.format.bit_rate) : null,
      channels: stream.channels ?? null,
      sampleRate: stream.sample_rate ? Number(stream.sample_rate) : null,
    };
  } catch {
    return null;
  }
}

/** Tries a real Vorbis encoder, falls back to another, then gives up (copyThrough) — ffmpeg builds vary in which encoders they were compiled with (see this script's own testing notes), and this runs on whatever machine happens to invoke `npm run build`. */
function compressOgg(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const attempts = [
    ["-c:a", "libvorbis", "-q:a", "3", "-ac", "2"],
    ["-c:a", "vorbis", "-strict", "-2", "-q:a", "3", "-ac", "2"],
  ];
  for (const args of attempts) {
    try {
      execFileSync("ffmpeg", ["-y", "-v", "error", "-i", src, ...args, dest], { stdio: ["ignore", "ignore", "pipe"] });
      return true;
    } catch {
      // try the next encoder
    }
  }
  return false;
}

function hasFfmpeg() {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function run() {
  // Wiped, not merged into, on every run — otherwise a renamed/removed
  // asset's old compressed copy would just sit here forever. Nothing here
  // is ever the source of truth (assets/ is), so there's nothing lost by
  // starting clean each time.
  fs.rmSync(CACHE, { recursive: true, force: true });

  const manifestPaths = getManifestPaths();
  console.log(`Compressing assets (mesh precision: ${halfFloat ? "half-float / meshopt" : "quantize only"})...`);
  const assets = [];
  const unusedAssets = [];

  if (fs.existsSync(MODELS_SRC)) {
    for (const name of fs.readdirSync(MODELS_SRC)) {
      if (!name.toLowerCase().endsWith(".glb")) continue;
      const relPath = `assets/models/${name}`;
      const src = path.join(MODELS_SRC, name);
      if (!manifestPaths.has(relPath)) {
        const bytes = fs.statSync(src).size;
        console.warn(`  models/${name}: not referenced in src/game/assets.ts, skipping (${fmtBytes(bytes)} unused on disk)`);
        unusedAssets.push({ name, kind: "model", relPath, bytes });
        continue;
      }
      const dest = path.join(CACHE, "models", name);
      const beforeBytes = fs.statSync(src).size;
      const entry = { name, kind: "model", relPath };
      try {
        const { before, after } = await compressGlb(src, dest);
        const afterBytes = fs.statSync(dest).size;
        reportRow(`models/${name}`, beforeBytes, afterBytes);
        Object.assign(entry, { beforeBytes, afterBytes, compressed: true, inspectBefore: before, inspectAfter: after });
      } catch (err) {
        console.warn(`  models/${name}: compression failed (${err.message}), using original`);
        copyThrough(src, dest);
        Object.assign(entry, { beforeBytes, afterBytes: beforeBytes, compressed: false, error: err.message });
      }
      assets.push(entry);
    }
  }

  if (fs.existsSync(SOUNDS_SRC)) {
    const ffmpegAvailable = hasFfmpeg();
    for (const name of fs.readdirSync(SOUNDS_SRC)) {
      if (!name.toLowerCase().endsWith(".ogg")) continue;
      const relPath = `assets/sounds/${name}`;
      const src = path.join(SOUNDS_SRC, name);
      if (!manifestPaths.has(relPath)) {
        const bytes = fs.statSync(src).size;
        console.warn(`  sounds/${name}: not referenced in src/game/assets.ts, skipping (${fmtBytes(bytes)} unused on disk)`);
        unusedAssets.push({ name, kind: "audio", relPath, bytes });
        continue;
      }
      const dest = path.join(CACHE, "sounds", name);
      const beforeBytes = fs.statSync(src).size;
      const entry = { name, kind: "audio", relPath, audioBefore: probeAudio(src) };
      if (ffmpegAvailable && compressOgg(src, dest)) {
        const afterBytes = fs.statSync(dest).size;
        reportRow(`sounds/${name}`, beforeBytes, afterBytes);
        Object.assign(entry, { beforeBytes, afterBytes, compressed: true, audioAfter: probeAudio(dest) });
      } else {
        if (!ffmpegAvailable) console.warn(`  sounds/${name}: ffmpeg not found on PATH, using original`);
        else console.warn(`  sounds/${name}: ffmpeg re-encode failed, using original`);
        copyThrough(src, dest);
        Object.assign(entry, { beforeBytes, afterBytes: beforeBytes, compressed: false });
      }
      assets.push(entry);
    }
  }

  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, "report.json"), JSON.stringify({ generatedAt: new Date().toISOString(), halfFloat, assets, unusedAssets }, null, 2));
}

run().catch((err) => {
  // Asset compression is a size optimization, not a correctness requirement
  // — a failure here shouldn't block a build. build.sh's inline step falls
  // back to assets/ directly if .build-cache/ has nothing for a given path.
  console.warn("Asset compression step failed, build will use uncompressed assets:", err.message);
});
