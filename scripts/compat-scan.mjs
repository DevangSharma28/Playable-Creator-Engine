#!/usr/bin/env node
/**
 * The ad-network compatibility gate.
 *
 * A playable is loaded by whatever WebView the network happens to use, and
 * those are old — a review device on Android 8 is running a Chromium from
 * 2017, and iOS in-app WebViews follow the OS, not Safari. Syntax the bundler
 * left untranspiled produces `SyntaxError: Unexpected token` before a single
 * line runs, and the submission bounces with nothing else to go on.
 *
 * Two classes of problem are checked, and the second is the one that used to
 * get through:
 *
 *  - **Syntax** — `?.`, `??`, `static{}`, `catch{}`, `||=`. A bundler target
 *    setting controls these, so they only appear after a regression.
 *  - **Runtime APIs** — `Array.prototype.at`, `Object.hasOwn`,
 *    `String.replaceAll`, `structuredClone`. esbuild's `target` transpiles
 *    *syntax* and does not polyfill *methods*, so one of these reaching the
 *    bundle from a dependency compiles perfectly and throws
 *    `undefined is not a function` on the review device.
 *
 * Extracted from build.sh so it can be tested directly — see
 * tests/compat-scan.test.mjs, which asserts each rule fires on the pattern it
 * describes and, just as importantly, that a clean bundle produces nothing.
 *
 *   node scripts/compat-scan.mjs dist/index.html [--json]
 *
 * Exit code 0 when clean, 2 when anything was found.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {object} CompatRule
 * @property {string} label     What was found, in the terms a reader will search for.
 * @property {RegExp} pattern   Matched against the whole shipped file.
 * @property {string} since     The ES version or API that introduced it.
 * @property {string} breaks    The oldest environments this actually fails on.
 * @property {string} hint      What to change.
 */

/** @type {CompatRule[]} */
export const RULES = [
  {
    label: 'ES module <script> tag (type="module")',
    pattern: /type="module"/g,
    since: "ES2015 modules",
    breaks: "Some review WebViews reject module scripts outright; file:// blocks them via CORS regardless.",
    hint: 'Check vite.config.prod.mts\'s rollupOptions.output.format is "iife".',
  },
  {
    label: "crossorigin attribute",
    pattern: /\bcrossorigin\b/g,
    since: "n/a",
    breaks: "Left over from Vite's default module script tag.",
    hint: "The build's own HTML post-processing should have stripped it; if this fires, that step did not run.",
  },
  {
    label: "import statement",
    pattern: /\bimport[ ({]/g,
    since: "ES2015",
    breaks: "Real ES import syntax in a file loaded as a classic script.",
    hint: 'Check rollupOptions.output.format is still "iife" and nothing new uses a dynamic import().',
  },
  {
    label: "export statement",
    pattern: /\bexport[ ({]/g,
    since: "ES2015",
    breaks: "Real ES export syntax in a file loaded as a classic script.",
    hint: "Same check as import: the output format.",
  },
  {
    label: "class static {} block",
    pattern: /static\{/g,
    since: "ES2022",
    breaks: "Chrome < 94, Safari < 16.4. This exact pattern is what produced the first such failure.",
    hint: "Check vite.config.prod.mts's build.target.",
  },
  {
    label: "optional catch binding — catch {}",
    pattern: /catch\{/g,
    since: "ES2019",
    breaks: "Chrome < 66, Safari < 11.1.",
    hint: "Same fix: build.target.",
  },
  {
    label: "optional chaining — ?.",
    pattern: /\?\.[a-zA-Z_$(]/g,
    since: "ES2020",
    breaks: "Chrome < 80, Safari < 13.1.",
    hint: "Same fix: build.target.",
  },
  {
    label: "nullish coalescing — ??",
    pattern: /[^?]\?\?[^?]/g,
    since: "ES2020",
    breaks: "Chrome < 80, Safari < 13.1.",
    hint: "Same fix: build.target.",
  },
  {
    label: "logical assignment — ||= &&= ??=",
    pattern: /(?:\|\||&&|\?\?)=[^=]/g,
    since: "ES2021",
    breaks: "Chrome < 85, Safari < 14.",
    hint: "Same fix: build.target.",
  },
  {
    label: "BigInt literal",
    pattern: /\b\d+n\b/g,
    since: "ES2020",
    breaks: "Chrome < 67, Safari < 14. Cannot be transpiled — it needs a different implementation.",
    hint: "Find the dependency using BigInt and replace it; build.target will not help here.",
  },
  {
    label: "regular expression lookbehind — (?<= (?<!",
    pattern: /\(\?<[=!]/g,
    since: "ES2018",
    breaks: "Safari < 16.4, including every iOS WebView before 16.4. Throws at parse time.",
    hint: "Rewrite the expression without lookbehind. A bundler target cannot transpile this.",
  },
  // ── Runtime APIs. `target` transpiles syntax, never methods. ──────────────
  {
    label: "Array.prototype.at() / String.prototype.at()",
    pattern: /\.at\(\s*-?\d/g,
    since: "ES2022 (runtime)",
    breaks: "Chrome < 92, Safari < 15.4. Fails as 'undefined is not a function' at the moment it runs.",
    hint: "Use index arithmetic instead, or ship a polyfill.",
  },
  {
    label: "Object.hasOwn()",
    pattern: /\bObject\.hasOwn\(/g,
    since: "ES2022 (runtime)",
    breaks: "Chrome < 93, Safari < 15.4.",
    hint: "Use Object.prototype.hasOwnProperty.call().",
  },
  {
    label: "String.prototype.replaceAll()",
    pattern: /\.replaceAll\(/g,
    since: "ES2021 (runtime)",
    breaks: "Chrome < 85, Safari < 13.1.",
    hint: "Use .replace() with a global regular expression.",
  },
  {
    label: "structuredClone()",
    pattern: /\bstructuredClone\(/g,
    since: "2022 (runtime)",
    breaks: "Chrome < 98, Safari < 15.4.",
    hint: "Use JSON round-tripping or an explicit clone.",
  },
  {
    label: "Array.prototype.flat() / .flatMap()",
    pattern: /\.flatMap\(|\.flat\(\s*[\d)]/g,
    since: "ES2019 (runtime)",
    breaks: "Chrome < 69, Safari < 12.",
    hint: "Use reduce/concat.",
  },
  {
    label: "Promise.allSettled() / Promise.any()",
    pattern: /\bPromise\.(?:allSettled|any)\(/g,
    since: "ES2020/ES2021 (runtime)",
    breaks: "allSettled: Chrome < 76, Safari < 13. any: Chrome < 85, Safari < 14.",
    hint: "Use Promise.all with per-promise catch handlers.",
  },
];

/**
 * Removes inlined asset payloads before scanning.
 *
 * A single-file playable is mostly base64 — a few hundred kilobytes of model
 * and audio data sitting in the same file as the code. The base64 alphabet
 * happily produces sequences like `16n`, so scanning the raw file reported
 * five BigInt literals in a bundle that contains none, and a gate that cries
 * wolf gets switched off. Only the code is scanned; the payloads are replaced
 * with a marker of the same shape so nothing else shifts.
 */
export function stripInlinedAssets(source) {
  return source.replace(/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, "data:inlined;base64,");
}

/**
 * @param {string} source The shipped HTML, as text.
 * @returns {{ label: string, count: number, since: string, breaks: string, hint: string }[]}
 */
export function scanCompat(source) {
  const code = stripInlinedAssets(source);
  const findings = [];
  for (const rule of RULES) {
    // Fresh lastIndex each time — these are global regexes and `match` is
    // called repeatedly across files in the test suite.
    rule.pattern.lastIndex = 0;
    const count = (code.match(rule.pattern) ?? []).length;
    if (count > 0) findings.push({ label: rule.label, count, since: rule.since, breaks: rule.breaks, hint: rule.hint });
  }
  return findings;
}

/**
 * The environments ION commits to.
 *
 * Derived from the oldest version every rule above allows, plus the WebGL and
 * WebAudio requirements the engine has regardless of syntax. Published rather
 * than implied, because "which phones does this run on" is the first question
 * an ad network asks and the answer should not be a guess.
 */
export const SUPPORT_MATRIX = [
  { environment: "Chrome / Edge (desktop + Android)", minimum: "64", notes: "WebGL2, WebAudio, ES2015 bundle." },
  { environment: "Safari (macOS)", minimum: "15", notes: "WebGL2 is unflagged from 15." },
  { environment: "iOS Safari and every iOS in-app WebView", minimum: "15.0", notes: "iOS WebViews follow the OS version, not the installed Safari." },
  { environment: "Android System WebView", minimum: "64", notes: "What most ad-network review apps embed." },
  { environment: "Firefox", minimum: "63", notes: "Not an ad-network target; supported for development." },
  { environment: "Samsung Internet", minimum: "9.2", notes: "Chromium 67-based." },
];

/** Environments ION explicitly does not support, and why. */
export const UNSUPPORTED = [
  { environment: "Internet Explorer, any version", reason: "No WebGL2, no ES2015. Not a target and will not become one." },
  { environment: "iOS < 15", reason: "WebGL2 is behind a flag, so the renderer cannot start." },
  { environment: "Android < 7 / WebView < 64", reason: "No WebGL2." },
  { environment: "Any environment with WebGL disabled or unavailable", reason: "The engine shows its recovery CTA rather than a blank canvas — see CrashOverlay." },
  { environment: "Node / SSR", reason: "The runtime imports without a DOM, but nothing renders. There is no headless mode." },
];

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith("--")) ?? "dist/index.html";
  if (!fs.existsSync(file)) {
    console.error(`✖ ${file} does not exist — run the build first.`);
    process.exit(1);
  }
  const findings = scanCompat(fs.readFileSync(file, "utf8"));
  if (args.includes("--json")) {
    console.log(JSON.stringify(findings, null, 2));
  } else if (findings.length) {
    console.log(`\n⚠ Ad-network compatibility warnings found in ${path.basename(file)}:`);
    for (const finding of findings) {
      console.log(`  - ${finding.label}: ${finding.count} occurrence(s) [${finding.since}]`);
      console.log(`      ${finding.breaks}`);
      console.log(`      ${finding.hint}`);
    }
    console.log("These patterns are known to fail ad-network review (Mintegral's Mindworks among them).\n");
  } else {
    console.log("✓ No known ad-network compatibility issues found (no ES-module syntax, no ES2019+ syntax, no post-ES2018 runtime APIs).");
  }
  process.exit(findings.length ? 2 : 0);
}
