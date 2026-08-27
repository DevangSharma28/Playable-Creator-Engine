/**
 * The ad-network compatibility gate's own rules.
 *
 * The gate is the last thing standing between a build and a submission that
 * bounces with `SyntaxError: Unexpected token` and no other detail, so it is
 * worth knowing that each rule fires on the pattern it names — and, at least
 * as much, that it stays quiet on a clean bundle. A gate with a false positive
 * gets bypassed, and then it protects nothing at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RULES, scanCompat, stripInlinedAssets, SUPPORT_MATRIX, UNSUPPORTED } from "../scripts/compat-scan.mjs";

const found = (source, label) => scanCompat(source).find((finding) => finding.label === label);

test("each rule fires on the pattern it describes", async (t) => {
  const samples = {
    'ES module <script> tag (type="module")': '<script type="module" src="a.js"></script>',
    "crossorigin attribute": '<script crossorigin src="a.js"></script>',
    "import statement": 'import {a} from "b";',
    "export statement": "export {a};",
    "class static {} block": "class A{static{this.x=1}}",
    "optional catch binding — catch {}": "try{f()}catch{g()}",
    "optional chaining — ?.": "const v=a?.b;",
    "nullish coalescing — ??": "const v = a ?? b;",
    "logical assignment — ||= &&= ??=": "a ||= b;",
    "BigInt literal": "const big = 9007199254740993n;",
    "regular expression lookbehind — (?<= (?<!": "const re = /(?<=a)b/;",
    "Array.prototype.at() / String.prototype.at()": "const last = list.at(-1);",
    "Object.hasOwn()": "if (Object.hasOwn(o, 'k')) {}",
    "String.prototype.replaceAll()": 'const s = t.replaceAll("a", "b");',
    "structuredClone()": "const copy = structuredClone(value);",
    "Array.prototype.flat() / .flatMap()": "const f = list.flatMap(x => x);",
    "Promise.allSettled() / Promise.any()": "await Promise.allSettled(jobs);",
  };

  await t.test("every rule has a sample", () => {
    // If a rule is added without one, this says so rather than silently
    // leaving it untested.
    const missing = RULES.map((rule) => rule.label).filter((label) => !(label in samples));
    assert.deepEqual(missing, [], `rules with no sample: ${missing.join(", ")}`);
  });

  for (const [label, sample] of Object.entries(samples)) {
    await t.test(label, () => {
      const finding = found(sample, label);
      assert.ok(finding, `"${sample}" did not trigger "${label}"`);
      assert.ok(finding.count >= 1);
      assert.ok(finding.breaks.length > 0, "the finding does not say what it breaks");
      assert.ok(finding.hint.length > 0, "the finding does not say what to do");
    });
  }
});

test("a clean ES2015 bundle produces nothing", async (t) => {
  await t.test("plain transpiled output is silent", () => {
    const clean = `<!doctype html><html><body><script>
      (function(){
        "use strict";
        var list = [1,2,3];
        for (var i = 0; i < list.length; i++) { console.log(list[i]); }
        try { risky(); } catch (e) { console.error(e); }
        var v = a != null ? a.b : void 0;
        var w = a !== null && a !== void 0 ? a : b;
      })();
    </script></body></html>`;
    assert.deepEqual(scanCompat(clean), []);
  });

  await t.test("inlined base64 assets are not mistaken for code", () => {
    // The base64 alphabet produces sequences like "16n" freely. Scanning the
    // raw file reported five BigInt literals in a bundle containing none.
    const payload = "XMbfr6dBlDSWxmP3a7ZDTXXASy7nk641pjc9fbyFp8em+16n+tk0r1M5213F";
    const html = `<script>var m="data:model/gltf-binary;base64,${payload}";</script>`;
    assert.deepEqual(scanCompat(html), [], "a base64 payload triggered a rule");
  });

  await t.test("stripping leaves the surrounding code intact", () => {
    const html = `var a="data:image/png;base64,AAAA";var last=list.at(-1);`;
    const stripped = stripInlinedAssets(html);
    assert.ok(!stripped.includes("AAAA"), "the payload survived");
    assert.ok(stripped.includes("list.at(-1)"), "code around the payload was lost");
  });
});

test("the real production bundle passes its own gate", async (t) => {
  const dist = path.resolve(import.meta.dirname, "..", "dist", "index.html");
  await t.test(
    "dist/index.html is clean",
    { skip: fs.existsSync(dist) ? false : "no build on disk — run npm run build first" },
    () => {
      const findings = scanCompat(fs.readFileSync(dist, "utf8"));
      assert.deepEqual(
        findings.map((finding) => `${finding.label} ×${finding.count}`),
        [],
        "the shipped bundle contains syntax or APIs an ad-network WebView will reject"
      );
    }
  );
});

test("the support matrix is stated, not implied", async (t) => {
  await t.test("every supported environment names a minimum version", () => {
    assert.ok(SUPPORT_MATRIX.length >= 5);
    for (const row of SUPPORT_MATRIX) {
      assert.ok(row.environment && row.minimum && row.notes, `incomplete row: ${JSON.stringify(row)}`);
    }
  });

  await t.test("every unsupported environment says why", () => {
    assert.ok(UNSUPPORTED.length >= 3);
    for (const row of UNSUPPORTED) {
      assert.ok(row.environment && row.reason, `incomplete row: ${JSON.stringify(row)}`);
    }
  });

  await t.test("the matrix covers the WebViews ad networks actually use", () => {
    const environments = SUPPORT_MATRIX.map((row) => row.environment.toLowerCase()).join(" ");
    assert.match(environments, /android system webview/);
    assert.match(environments, /ios/);
  });
});
