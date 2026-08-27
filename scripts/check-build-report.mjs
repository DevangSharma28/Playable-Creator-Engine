#!/usr/bin/env node
// Reads dist/build-report.json and fails if the build produced something
// that should not be submitted.
//
// build.sh runs this as its own final step, so `npm run build` exits non-zero
// on a finding. It runs *last* on purpose: dist/index.html, the report, and
// the zip are all written first, so a failing build still leaves a complete,
// inspectable artifact on disk. You get the non-zero exit code *and* the
// broken output to look at — seeing that output is often how you work out
// what caused it.
//
//   node scripts/check-build-report.mjs                  # fail on any finding
//   node scripts/check-build-report.mjs --allow-warnings # report, exit 0
//   ALLOW_COMPAT_WARNINGS=1 npm run build                # same, via build.sh
//
// ## Exit codes
//
//   0  clean, or downgraded to a report
//   1  could not check — no report, or it isn't valid JSON
//   2  checked, and the build is not submittable
//
// 2 is distinct from 1 because they mean opposite things to a caller.
// scripts/dev-build-api.js's POST /build branches on it: exit 2 means the
// build genuinely succeeded and the Builder panel should still paint the real
// size figures — just flagged — while any other non-zero exit is a build
// failure with nothing worth painting.
//
// Writes a GitHub job summary when $GITHUB_STEP_SUMMARY is set, so the size
// numbers land on the PR without anyone opening the log.

import fs from "node:fs";
import path from "node:path";

// ION_PROJECT_ROOT when `ion build` set it, cwd otherwise — build.sh already
// runs from the project root, so this only removes a hidden dependency on that
// staying true.
const REPORT = path.join(process.env.ION_PROJECT_ROOT || process.cwd(), "dist", "build-report.json");
// The env var is the escape hatch build.sh forwards, so `ALLOW_COMPAT_WARNINGS=1
// npm run build` works without anyone having to know this script exists.
const allowWarnings =
  process.argv.includes("--allow-warnings") ||
  ["1", "true", "yes"].includes((process.env.ALLOW_COMPAT_WARNINGS ?? "").toLowerCase());

/** Not submittable — see the exit-code table above. */
const EXIT_NOT_SUBMITTABLE = 2;
/** Could not check at all. */
const EXIT_CANNOT_CHECK = 1;

if (!fs.existsSync(REPORT)) {
  console.error(`✖ ${REPORT} not found — run \`npm run build\` first.`);
  process.exit(EXIT_CANNOT_CHECK);
}

/** @type {{distBytes:number,gzipBytes:number,budgetBytes:number,overBudget:boolean,buildDurationSec:number,halfFloat:boolean,compatibilityWarnings:string[],unusedAssets:{path?:string,name?:string}[]}} */
let report;
try {
  report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
} catch (err) {
  console.error(`✖ ${REPORT} is not valid JSON: ${err.message}`);
  process.exit(EXIT_CANNOT_CHECK);
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const kb = (n) => `${Math.round(n / 1024).toLocaleString()} KB`;

const warnings = Array.isArray(report.compatibilityWarnings) ? report.compatibilityWarnings : [];
const unused = Array.isArray(report.unusedAssets) ? report.unusedAssets : [];
const failures = [];

// The one finding that means "this build will fail ad-network review" rather
// than "here's room to optimize". Every pattern here is supposed to be
// impossible given vite.config.prod.mts's format:"iife" / target:"es2015" —
// a hit means one of those regressed, most likely via a dependency upgrade.
if (warnings.length > 0) {
  failures.push(`${warnings.length} ad-network compatibility warning${warnings.length === 1 ? "" : "s"}`);
}

// The Builder panel draws this budget; nothing enforced it until now.
if (report.overBudget) {
  failures.push(`over the ${mb(report.budgetBytes)} size budget (${mb(report.distBytes)})`);
}

console.log("");
console.log("Build report");
console.log(`  dist/index.html   ${mb(report.distBytes)}  (${kb(report.gzipBytes)} gzipped)`);
console.log(`  budget            ${mb(report.budgetBytes)}${report.overBudget ? "  ✖ OVER" : "  ✓"}`);
console.log(`  build duration    ${report.buildDurationSec}s`);
console.log(`  mesh compression  ${report.halfFloat ? "meshopt (half float)" : "quantize only"}`);
console.log(`  compatibility     ${warnings.length === 0 ? "✓ clean" : `✖ ${warnings.length} warning(s)`}`);
if (unused.length > 0) {
  console.log(`  unused assets     ${unused.length} on disk but not referenced`);
}
console.log("");

for (const warning of warnings) console.error(`  ✖ ${warning}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = [
    "### Build report",
    "",
    "| | |",
    "| --- | --- |",
    `| \`dist/index.html\` | ${mb(report.distBytes)} (${kb(report.gzipBytes)} gzipped) |`,
    `| Budget | ${mb(report.budgetBytes)} ${report.overBudget ? "— **over**" : "— ok"} |`,
    `| Duration | ${report.buildDurationSec}s |`,
    `| Ad-network compatibility | ${warnings.length === 0 ? "clean" : `**${warnings.length} warning(s)**`} |`,
    `| Unused assets | ${unused.length} |`,
    "",
  ];
  if (warnings.length > 0) {
    rows.push("#### Compatibility warnings", "");
    for (const warning of warnings) rows.push(`- ${warning}`);
    rows.push("");
  }
  if (unused.length > 0) {
    rows.push("<details><summary>Unused assets</summary>", "");
    for (const asset of unused) rows.push(`- \`${asset.path ?? asset.name ?? String(asset)}\``);
    rows.push("", "</details>", "");
  }
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, rows.join("\n"));
}

if (failures.length === 0) {
  console.log("✓ Build is submittable.");
  process.exit(0);
}

console.error(`✖ Build not submittable: ${failures.join("; ")}.`);
console.error("  dist/index.html was still written — inspect it, then fix the cause.");
if (allowWarnings) {
  console.error("  (warnings allowed — reporting only.)");
  process.exit(0);
}
console.error("  To build anyway: ALLOW_COMPAT_WARNINGS=1 npm run build");
process.exit(EXIT_NOT_SUBMITTABLE);
