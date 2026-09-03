#!/usr/bin/env node
/**
 * Stamps the ION mark into every page that shows a browser tab.
 *
 * ## Why a data URI and not a favicon.png
 *
 * The pages that need this are served by **three** different things: Vite from
 * the project root (`index.html`), Vite's `public/` (the guides), and — in a
 * generated project — the packaged Studio's own middleware, which serves a
 * deliberately closed list of files off `@ion-engine/editor/studio` (see
 * `packages/project/lib/dev.mjs`). A `<link href="/favicon.png">` would have to
 * be taught to all three, plus `scripts/build-packages.mjs`'s copy list, and a
 * missing rule shows up as a silently absent icon rather than an error.
 *
 * Inlining sidesteps all of it: the icon travels inside the HTML, so it works
 * from Vite, from the packaged Studio, from `file://`, and offline, with no
 * serving rule to keep in sync. At 64x64 it is ~4 KB per page against files
 * that are already 20–350 KB.
 *
 * ## Why a script and not a hand-pasted string
 *
 * Six pages carry the same blob. Pasting it by hand means the day the logo
 * changes, five of them keep the old one. Re-run this instead:
 *
 *   node scripts/make-favicon.mjs
 *
 * It is idempotent — the tag sits between markers and is replaced, never
 * appended.
 *
 * ## Why the production template is not in the list
 *
 * `src/index.template.html` becomes the shipped playable, which runs inside an
 * ad network's WebView. There is no browser tab there, so the bytes could never
 * be seen — and every byte counts against the size budget the build gates on.
 * Add `"src/index.template.html"` to PAGES below if you want branded demo links
 * and are happy to pay ~4 KB for them.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "src", "engine", "icon", "IONENGINE_ICON.png");

/**
 * 64 rather than 32: browsers pick this for retina tabs, macOS touch bars and
 * the bookmark bar, and downscale it themselves for the 16px case. 32 saves
 * 1.7 KB and looks soft on every modern display.
 */
const SIZE = 64;

const PAGES = [
  "index.html",                      // the Engine Room dev preview
  "tools/ui-editor.html",            // synced to public/ by scripts/sync-assets.js
  "public/guide.html",
  "public/guide-colliders.html",
  "public/guide-particles.html",
  "public/guide-ui-editor.html",
];

const BEGIN = "<!-- ion:favicon -->";
const END = "<!-- /ion:favicon -->";

const png = await sharp(SOURCE)
  // `contain` rather than `cover`: the mark is square already, but a future
  // one might not be, and cropping a logo to fit is worse than padding it.
  .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9, palette: true })
  .toBuffer();

const block = `${BEGIN}\n  <link rel="icon" type="image/png" href="data:image/png;base64,${png.toString("base64")}">\n  ${END}`;

let written = 0;
for (const page of PAGES) {
  const file = join(ROOT, page);
  const html = readFileSync(file, "utf8");
  let next;

  if (html.includes(BEGIN)) {
    next = html.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), block);
  } else {
    // After </title>, which every one of these pages has — the icon and the
    // tab's name belong together, and it keeps the diff in one predictable
    // place rather than wherever <head> happened to start.
    const match = /<\/title>/i.exec(html);
    if (!match) {
      console.warn(`  skipped ${page} — no <title> to anchor to`);
      continue;
    }
    const at = match.index + match[0].length;
    next = `${html.slice(0, at)}\n  ${block}${html.slice(at)}`;
  }

  if (next === html) continue;
  writeFileSync(file, next, "utf8");
  written++;
  console.log(`  ${relative(ROOT, file)}`);
}

console.log(`\n✓ ION favicon (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB) stamped into ${written} page${written === 1 ? "" : "s"}`);
