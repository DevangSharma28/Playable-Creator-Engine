#!/usr/bin/env node
// Tiny localhost-only HTTP API two dev-only pages talk to, since a browser
// can't shell out to build.sh/git, read/parse TS source, or write straight
// into the project on its own: the dev page's ION Engine panel (GET
// /version, POST /build), and tools/ui-editor.html's Save/Set-as-Main/
// Set-as-Endcard/Load (see /save-layout, /load-layout, /list-layouts) plus
// its read-only Scripts panel (see /list-scripts, /script-info). Runs
// alongside esbuild's dev server (see scripts/dev.js) — never part of the
// production build, never listens on anything but 127.0.0.1.
const http = require("http");
const { exec, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 8001;
const ROOT = path.join(__dirname, "..");
const PACKAGE_VERSION = require(path.join(ROOT, "package.json")).version;
const UI_DIR = path.join(ROOT, "src", "game", "ui"); // src/ is split into engine/ (reusable) and game/ (this playable ad) — mainLayout.json/endcardLayout.json live under the latter
const LAYOUTS_DIR = path.join(UI_DIR, "layouts");
const ACTIVE_FILES = { main: "mainLayout.json", endcard: "endcardLayout.json" };
// Drag-and-drop field assignments from the Scripts panel — see /list-bindings,
// /save-binding, /remove-binding below, and src/engine/Bindings.ts (the
// runtime side that reads this same file to actually wire fields up).
const BINDINGS_FILE = path.join(UI_DIR, "bindings.json");
const SRC_DIR = path.join(ROOT, "src");
const SCRIPT_CATEGORIES = { engine: path.join(SRC_DIR, "engine"), game: path.join(SRC_DIR, "game") };

/**
 * tools/ui-editor.html's Save/Set-as-Main/Set-as-Endcard prefer writing
 * through here (see /save-layout below) over the browser's File System
 * Access API — that API needs a one-time folder picker with zero
 * validation of what got picked (pick the project root instead of src/ui/
 * by one click and every save silently lands in the wrong place, no error,
 * game never updates), plus it's Chrome/Edge-only and can behave
 * differently inside the embedded editor iframe. This process already has
 * real fs access rooted at the actual project directory (same as /build
 * below), so there's no folder to get wrong and no browser permission to
 * grant — it's exactly as reliable as the Build button already is.
 */
function sanitizeLayoutFilename(name) {
  const base = path.basename(String(name || "")); // strips any directory components — the only defense this needs against path traversal
  return /\.json$/i.test(base) ? base : base + ".json";
}

/**
 * Backing /list-scripts and /script-info below — the UI editor's read-only
 * Scripts panel (see tools/ui-editor.html).
 *
 * This is a brace-depth-aware text scan, not a real parse — the
 * `typescript` package installed here (v7) turned out to have dropped the
 * classic Node-facing AST API (`ts.createSourceFile` etc.) from its main
 * entry in favor of a new native/Go-backed compiler with a different,
 * unstable API surface, so reusing tsc's own AST the way the rest of this
 * repo does for typechecking isn't available for a quick script like this.
 * Good enough for a *read-only, informational* panel — this only needs to
 * recognize this codebase's own consistent style (constructor parameter
 * properties, `name: Type = value;` field declarations), not handle
 * arbitrary TypeScript.
 */
function walkTsFiles(dir, baseDir, into) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, baseDir, into);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      into.push(path.relative(baseDir, full).split(path.sep).join("/"));
    }
  }
}

/** Collapses every nested {...} block (method/constructor bodies, object literals, arrow-function bodies — any depth) into a single "{…}" placeholder, so a regex scan over what's left only ever sees the class's own direct members, never a `const` inside some method mistaken for a field. */
function blankNestedBraces(text) {
  let result = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) result += "{…}";
      depth++;
    } else if (ch === "}") {
      depth--;
    } else if (depth === 0) {
      result += ch;
    }
  }
  return result;
}

/** Splits a parameter list on top-level commas only — one nested inside a `<...>` generic, `{...}` object type, or `(...)` (e.g. a callback type) doesn't split. */
function splitTopLevelParams(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "<" || ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

// Lookbehind, not a consuming group — `;` (or `}`, the tail of a blanked
// method's "{…}" placeholder) has to stay unconsumed so the *next* field
// right after it can still anchor on the same boundary. A consuming
// `(?:^|;)` here would eat each field's own trailing `;` as it matched,
// leaving nothing for the next field to anchor on and silently dropping
// every field after the first in a class.
const PUBLIC_FIELD_PATTERN = /(?<=^|;|\})\s*(?:(private|protected|public)\s+)?(readonly\s+)?([\w$]+)\s*(\?)?\s*(?::\s*([^=;{}]+?))?\s*(=\s*([^;]+?))?\s*;/g;

/**
 * Strips `//` and `/* *\/` comments, leaving string/template literal
 * *contents* untouched (a `//` inside a "http://..." URL string must never
 * be mistaken for a comment start) — this codebase's own doc comments are
 * full of prose that incidentally contains the word "class" or looks like
 * code (this file's *own* comment above literally has `readonly axis =
 * {x:0,y:0};` in it), which would otherwise false-positive match the class/
 * field scanners below.
 */
function stripComments(text) {
  let result = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      result += ch;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === "\\" && i + 1 < n) {
          result += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        result += text[i];
        i++;
      }
      if (i < n) {
        result += text[i];
        i++;
      }
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/**
 * Every class in a source file, with every field — plain field
 * declarations (`readonly axis = {x:0,y:0};`) and constructor parameter
 * properties (`constructor(private readonly base: HTMLElement)`, common
 * throughout this codebase), which are just as much real class fields as
 * the former even though they never appear in the class body itself. Each
 * is tagged with its real visibility ("public" when no modifier is
 * present, TS's own default) — this endpoint returns all of them,
 * regardless; it's the editor's Debug toggle (see tools/ui-editor.html's
 * renderScriptProperties) that decides whether private/protected ones
 * actually get shown.
 * "assigned" means a field declaration has an initializer, or a
 * constructor param has a default value in its signature — for the latter
 * that reads as "optional", for the former as "already has a real
 * default" — either way, distinct from "empty": a bare declaration or
 * required parameter with nothing backing it yet.
 */
function extractClasses(rawSourceText) {
  const sourceText = stripComments(rawSourceText);
  const classes = [];
  const classHeaderRe = /\bclass\s+([\w$]+)\b[^{]*\{/g;
  let headerMatch;
  while ((headerMatch = classHeaderRe.exec(sourceText))) {
    const className = headerMatch[1];
    const bodyStart = headerMatch.index + headerMatch[0].length;
    let depth = 1;
    let i = bodyStart;
    for (; i < sourceText.length && depth > 0; i++) {
      if (sourceText[i] === "{") depth++;
      else if (sourceText[i] === "}") depth--;
    }
    const bodyEnd = i - 1;
    const body = sourceText.slice(bodyStart, bodyEnd);
    classHeaderRe.lastIndex = i;

    const fields = [];

    // Constructor parameter properties — only params that actually carry a
    // visibility/readonly modifier are real class fields; a plain
    // `radius = 45` constructor parameter with no modifier is just a
    // regular argument, not a property. Every visibility is collected
    // (not just public) — the editor's own Debug toggle decides which to
    // actually display (see tools/ui-editor.html's renderScriptProperties).
    const ctorMatch = body.match(/constructor\s*\(([\s\S]*?)\)\s*(?::[^{]+)?\{/);
    if (ctorMatch) {
      for (const raw of splitTopLevelParams(ctorMatch[1])) {
        const p = raw.trim();
        if (!p) continue;
        const m = p.match(/^(?:(private|protected|public)\s+)?(readonly\s+)?([\w$]+)\s*(\?)?\s*:\s*([^=]+?)(?:\s*=\s*(.+))?$/);
        if (!m) continue;
        const [, visibility, readonly, name, optional, type, defaultValue] = m;
        if (!visibility && !readonly) continue; // no modifier at all — a plain argument, not a property
        fields.push({ name, type: type.trim(), assigned: !!defaultValue || !!optional, kind: "constructor-param", visibility: visibility || "public" });
      }
    }

    // Plain field declarations — scanned over the class body with every
    // nested block blanked out first (see blankNestedBraces), so this
    // only ever matches direct members, never something inside a method.
    // Every visibility collected here too, same reason as above.
    const blanked = blankNestedBraces(body);
    PUBLIC_FIELD_PATTERN.lastIndex = 0;
    let fieldMatch;
    while ((fieldMatch = PUBLIC_FIELD_PATTERN.exec(blanked))) {
      const [, visibility, , name, optional, type, , initializer] = fieldMatch;
      if (name === "constructor") continue; // never a real match (constructor has no trailing `;` right after its `{…}`), but skip defensively
      fields.push({
        name,
        type: type ? type.trim() : null,
        assigned: !!initializer || !!optional,
        kind: "field",
        visibility: visibility || "public",
      });
    }

    classes.push({ name: className, fields });
  }
  return classes;
}

/** Resolves a category+relative-path pair to a real file, refusing anything that escapes that category's own directory (the only defense a path like "../../etc/passwd" needs). */
function resolveScriptPath(category, relPath) {
  const baseDir = SCRIPT_CATEGORIES[category];
  if (!baseDir) return null;
  const resolved = path.join(baseDir, relPath);
  if (!resolved.startsWith(baseDir + path.sep)) return null;
  return resolved;
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** { version, bindings: [{category, path, className, fieldName, uiElementName}] } — {version:1, bindings:[]} if the file doesn't exist yet (fresh project, nothing dragged onto a field yet). */
function readBindings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BINDINGS_FILE, "utf8"));
    if (!Array.isArray(parsed.bindings)) throw new Error("malformed");
    return parsed;
  } catch {
    return { version: 1, bindings: [] };
  }
}

function writeBindings(data) {
  fs.mkdirSync(UI_DIR, { recursive: true });
  fs.writeFileSync(BINDINGS_FILE, JSON.stringify(data, null, 2));
}

// esbuild's dev server prints both of these as the "Local" URL depending on
// platform/version, and either is a completely normal way to end up
// browsing the page — the CORS origin allowed here has to match whichever
// one the tab is actually on, or the browser silently discards the
// response and the button just reads "API offline" for no visible reason.
const ALLOWED_ORIGINS = new Set(["http://localhost:8000", "http://127.0.0.1:8000"]);

/** Best-effort — a fresh clone with no commits yet, or no git on PATH, shouldn't break the panel, just show what it can. */
function readGitInfo() {
  const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  try {
    return {
      commit: run("git rev-parse --short HEAD"),
      branch: run("git rev-parse --abbrev-ref HEAD"),
      dirty: run("git status --porcelain").length > 0,
    };
  } catch {
    return { commit: null, branch: null, dirty: false };
  }
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/version") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ version: PACKAGE_VERSION, ...readGitInfo() }));
    return;
  }

  if (req.method === "POST" && req.url === "/build") {
    // Fixed, version-controlled command — never anything from the request
    // itself — so there's no injection surface regardless of who can reach
    // this port.
    exec("bash build.sh", { cwd: ROOT, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      res.setHeader("Content-Type", "application/json");
      if (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: err.message, stdout, stderr }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, stdout, stderr }));
    });
    return;
  }

  if (req.method === "POST" && req.url === "/save-layout") {
    readRequestBody(req, 20 * 1024 * 1024) // 20MB guard — a layout with inlined base64 images can get large, but not unbounded
      .then((raw) => {
        const body = JSON.parse(raw);
        const { kind, filename, data } = body;
        if (!data || typeof data !== "object") throw new Error("Missing layout data");

        let targetPath;
        if (kind === "main" || kind === "endcard") {
          targetPath = path.join(UI_DIR, ACTIVE_FILES[kind]);
        } else if (kind === "layout") {
          fs.mkdirSync(LAYOUTS_DIR, { recursive: true });
          targetPath = path.join(LAYOUTS_DIR, sanitizeLayoutFilename(filename));
        } else {
          throw new Error('kind must be "main", "endcard", or "layout"');
        }

        fs.writeFileSync(targetPath, JSON.stringify(data, null, 2));
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, path: path.relative(ROOT, targetPath) }));
      })
      .catch((err) => {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/load-layout")) {
    const query = new URL(req.url, "http://localhost").searchParams;
    const kind = query.get("kind");
    const filename = query.get("filename");
    try {
      let targetPath;
      if (kind === "main" || kind === "endcard") targetPath = path.join(UI_DIR, ACTIVE_FILES[kind]);
      else if (kind === "layout" && filename) targetPath = path.join(LAYOUTS_DIR, sanitizeLayoutFilename(filename));
      else throw new Error("Invalid kind/filename");
      const content = fs.readFileSync(targetPath, "utf8");
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(content);
    } catch (err) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Not found" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/list-layouts") {
    const result = { main: null, endcard: null, layouts: [] };
    for (const kind of ["main", "endcard"]) {
      try {
        const json = JSON.parse(fs.readFileSync(path.join(UI_DIR, ACTIVE_FILES[kind]), "utf8"));
        result[kind] = { filename: ACTIVE_FILES[kind], w: json.canvasWidth, h: json.canvasHeight };
      } catch {
        // Fresh project, that one doesn't exist yet — leave it null.
      }
    }
    try {
      for (const name of fs.readdirSync(LAYOUTS_DIR).filter((f) => f.endsWith(".json"))) {
        try {
          const json = JSON.parse(fs.readFileSync(path.join(LAYOUTS_DIR, name), "utf8"));
          result.layouts.push({ filename: name, name: json.name || name.replace(/\.json$/, ""), tag: json.tag || "", w: json.canvasWidth, h: json.canvasHeight });
        } catch {
          result.layouts.push({ filename: name, name: name.replace(/\.json$/, ""), broken: true });
        }
      }
    } catch {
      // No layouts/ dir yet — nothing saved there so far.
    }
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === "GET" && req.url === "/list-scripts") {
    const result = {};
    for (const [category, dir] of Object.entries(SCRIPT_CATEGORIES)) {
      const files = [];
      try {
        walkTsFiles(dir, dir, files);
      } catch {
        // Shouldn't happen (both dirs are checked into the repo), but an
        // empty list beats a 500 if one's ever missing mid-refactor.
      }
      // Only ui/ — the Scripts panel exists to assign designed UI elements
      // onto class fields (see /save-binding), which only ever makes sense
      // for the UI-layer classes (HUD, UILayout, ...). Game.ts, Player.ts,
      // CameraHandler.ts etc. have no assignable fields at all, so listing
      // them was just noise, not a real option.
      result[category] = files.filter((f) => f.startsWith("ui/")).sort();
    }
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/script-info")) {
    const query = new URL(req.url, "http://localhost").searchParams;
    const category = query.get("category");
    const relPath = query.get("path");
    try {
      const fullPath = relPath && resolveScriptPath(category, relPath);
      if (!fullPath) throw new Error("Invalid category/path");
      const source = fs.readFileSync(fullPath, "utf8");
      const classes = extractClasses(source);
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, category, path: relPath, classes }));
    } catch (err) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/list-bindings") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(readBindings()));
    return;
  }

  if (req.method === "POST" && req.url === "/save-binding") {
    readRequestBody(req, 1024 * 1024)
      .then((raw) => {
        const body = JSON.parse(raw);
        const { category, path: relPath, className, fieldName, uiElementName } = body;
        if (!category || !relPath || !className || !fieldName || !uiElementName) throw new Error("Missing category/path/className/fieldName/uiElementName");
        const data = readBindings();
        // One binding per class+field — dropping a new element onto an
        // already-bound field replaces it rather than stacking a second one.
        data.bindings = data.bindings.filter((b) => !(b.className === className && b.fieldName === fieldName));
        data.bindings.push({ category, path: relPath, className, fieldName, uiElementName });
        writeBindings(data);
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, bindings: data.bindings }));
      })
      .catch((err) => {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (req.method === "POST" && req.url === "/remove-binding") {
    readRequestBody(req, 1024 * 1024)
      .then((raw) => {
        const body = JSON.parse(raw);
        const { className, fieldName } = body;
        if (!className || !fieldName) throw new Error("Missing className/fieldName");
        const data = readBindings();
        data.bindings = data.bindings.filter((b) => !(b.className === className && b.fieldName === fieldName));
        writeBindings(data);
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, bindings: data.bindings }));
      })
      .catch((err) => {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Dev build API listening on http://127.0.0.1:${PORT} (GET /version, POST /build, POST /save-layout, GET /load-layout, GET /list-layouts, GET /list-scripts, GET /script-info, GET /list-bindings, POST /save-binding, POST /remove-binding)`);
});
