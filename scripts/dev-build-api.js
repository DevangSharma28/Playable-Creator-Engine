#!/usr/bin/env node
// Tiny localhost-only HTTP API two dev-only pages talk to, since a browser
// can't shell out to build.sh/git, read/parse TS source, or write straight
// into the project on its own: the dev page's ION Engine panel (GET
// /version, GET /estimate-size, POST /build), and tools/ui-editor.html's Save/Set-as-Main/
// Set-as-Endcard/Load (see /save-layout, /load-layout, /list-layouts) plus
// its read-only Scripts panel (see /list-scripts, /script-info). Runs
// alongside Vite's dev server (see scripts/dev.js) — never part of the
// production build, never listens on anything but 127.0.0.1.
const http = require("http");
const { exec, execFile, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

/** Overridable so a generated project can run its own API alongside ION's. The Engine Room reads the matching origin from `window.__ION_API_ORIGIN`, which `ion dev` injects — change one without the other and every Save silently 404s. */
const PORT = Number(process.env.ION_API_PORT ?? 8001);
/**
 * The project this API reads and writes.
 *
 * Two callers, two answers. Run directly out of this repository (ION's own
 * development mode) it is the repo root, exactly as it always was. Run from
 * inside a generated project's node_modules by `ion dev`, `__dirname` points
 * at the installed package instead — which would have this happily serving
 * and *writing* the engine's own src/game rather than the customer's. So the
 * CLI passes the real project root explicitly and the fallback stays put.
 */
const ROOT = process.env.ION_PROJECT_ROOT ? path.resolve(process.env.ION_PROJECT_ROOT) : path.join(__dirname, "..");
/**
 * A package.json's `version`, read fresh off disk.
 *
 * Deliberately `readFileSync` + `JSON.parse`, never `require`: `require`
 * memoises the parsed module for the life of the process, so even moving
 * these reads out of module scope would keep handing back the value the
 * first call saw.
 *
 * Best-effort — a generated project always has a package.json, but a
 * malformed or absent one shouldn't stop the API booting or take a request
 * down.
 */
function readVersion(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).version;
  } catch {
    return undefined;
  }
}

const projectVersion = () => readVersion(path.join(ROOT, "package.json")) ?? "0.0.0";

/**
 * The ION engine version, which is not the same thing as the project version.
 *
 * In a generated project these differ and it is the engine's that matters:
 * the Studio's version pill is answering "what am I running?", and a
 * customer's own 0.1.0 says nothing about that. Read from the installed
 * @ion-engine/runtime; in ION's own checkout there is no such package, and
 * the repo version *is* the engine version.
 *
 * **Resolved per request, not once at boot.** Both of these used to be
 * module-level constants, which made the version pill silently lie in the
 * one situation it exists for: upgrade the engine (or, with a `file:`
 * dependency, rebuild the packages) while `ion dev` is running, and the
 * panel kept reporting the version the server happened to start with —
 * indefinitely, and with no hint it was stale. Three long-lived dev servers
 * against the same project reported three different versions, none of them
 * what was on disk. Reading two small JSON files on a request that fires
 * once per panel load costs nothing worth measuring.
 */
const ionVersion = () => readVersion(path.join(ROOT, "node_modules", "@ion-engine", "runtime", "package.json")) ?? projectVersion();
const UI_DIR = path.join(ROOT, "src", "game", "ui"); // src/ is split into engine/ (reusable) and game/ (this playable ad) — mainLayout.json/endcardLayout.json live under the latter
const LAYOUTS_DIR = path.join(UI_DIR, "layouts");
const ACTIVE_FILES = { main: "mainLayout.json", endcard: "endcardLayout.json" };
// Drag-and-drop field assignments from the Scripts panel — see /list-bindings,
// /save-binding, /remove-binding below, and src/engine/Bindings.ts (the
// runtime side that reads this same file to actually wire fields up).
const BINDINGS_FILE = path.join(UI_DIR, "bindings.json");
// "⊙ Pick" assignments from the 3D Viewer/Editor's Control Desk — see
// /list-scene-bindings, /save-scene-binding, /remove-scene-binding below,
// and src/engine/SceneBindings.ts (the runtime side that reads this same
// file). Deliberately a sibling of the game's own source rather than under
// ui/: these bind fields to 3D scene objects, not to designed UI elements.
const SCENE_BINDINGS_FILE = path.join(ROOT, "src", "game", "sceneBindings.json");
// Colliders authored in the 3D editor's "Configure Colliders" mode — see
// /list-colliders and /save-colliders below, and
// src/engine/collision/ColliderSerialization.ts (the runtime side that
// reads this same file). Ships: it's a real import in Game.ts, so what's
// placed in the editor is what runs in the production build.
const COLLIDERS_FILE = path.join(ROOT, "src", "game", "colliders.json");
// Particle systems authored in the 3D editor's "Particle System" mode —
// see /list-particles and /save-particles below, and
// src/engine/particles/ParticleSerialization.ts (the runtime side that
// reads this same file). Ships for the same reason colliders.json does:
// it's a real import in Game.ts, so what's authored in the editor is what
// runs in the production build. Only the *configuration* is stored — never
// a snapshot of live particles.
const PARTICLES_FILE = path.join(ROOT, "src", "game", "particles.json");
// The 3D editor's Environment dock — camera framing, lighting, and world
// settings; see /list-environment and /save-environment below, and
// src/engine/scene/SceneEnvSerialization.ts (the runtime side that reads
// this same file). Ships for the same reason the two above do: what the
// panel authors is what the production playable renders.
const ENVIRONMENT_FILE = path.join(ROOT, "src", "game", "environment.json");
/** What the 3D editor changed about the scene graph itself — see src/engine/scene/SceneOverrides.ts. */
const SCENE_FILE = path.join(ROOT, "src", "game", "scene.json");
const SRC_DIR = path.join(ROOT, "src");
/**
 * Where the Scripts panel and Control Desk look for classes.
 *
 * `engine` only exists while ION is developed in-repo. A generated project
 * consumes the engine as a package, so there is no src/engine to scan — and
 * there shouldn't be: those files are not the customer's to edit. The
 * category is dropped entirely rather than left pointing at a missing
 * directory, so /list-scripts returns an honest empty list instead of an
 * error the panel would render as a broken API.
 */
const SCRIPT_CATEGORIES = { game: path.join(SRC_DIR, "game") };
if (fs.existsSync(path.join(SRC_DIR, "engine"))) SCRIPT_CATEGORIES.engine = path.join(SRC_DIR, "engine");
/**
 * Categories that always appear in a /list-scripts response, even when the
 * directory behind one doesn't exist.
 *
 * Dropping a key outright was a mistake: `{engine, game}` is a published
 * response shape, and tools/ui-editor.html reads `.engine.length` directly.
 * Removing `engine` for projects that consume the engine as a package turned
 * a correct "there is nothing here" into a TypeError that broke the whole
 * Scripts panel. An empty array says the same thing without breaking anyone.
 */
const REPORTED_CATEGORIES = ["engine", "game"];

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
/**
 * Reduces a client-supplied layout name to a single safe filename.
 *
 * `path.basename` alone is not enough: on POSIX a backslash is an ordinary
 * filename character, so `..\..\escape.json` survives it intact and is then
 * a real traversal the moment the same request is made on Windows. Both
 * separators are normalised first, and anything that still looks like a path
 * or a dot-segment is refused outright rather than silently rewritten into
 * some other file's name.
 */
function sanitizeLayoutFilename(name) {
  const raw = String(name || "").trim();
  if (!raw) throw new Error("A layout needs a filename.");
  // Both separators, plus NUL, which truncates a path in some syscalls.
  const base = path.basename(raw.replace(/\\/g, "/").replace(/\0/g, "")).replace(/^\.+/, "");
  if (!base || base === "." || base === "..") throw new Error(`"${raw}" is not a usable layout name.`);
  if (/[/\\]/.test(base)) throw new Error(`"${raw}" is not a usable layout name.`);
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

/** Newest mtime (ms) among every file under `dir`, recursively — used by isBuildStale() below to tell whether anything's changed since the last build without needing a real diff. */
function newestMtimeMs(dir) {
  // The directory's own mtime, not just its children's — a plain file-mtime
  // scan never notices a *deletion* (removing a file changes nothing about
  // any file that's still there), so renaming/removing an asset silently
  // failed to mark a build stale. A directory's mtime does update when an
  // entry is added or removed (verified on this project's filesystem), so
  // folding it in here catches that case the same way an edited file would.
  let newest = fs.statSync(dir).mtimeMs;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeMs(full));
    } else if (entry.isFile()) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

/** Whether `src/`, `tools/ui-editor.html`, or `assets/` have anything newer than `builtAtMs` (the last dist/index.html's own mtime) — backs the Builder panel's "may be out of date" hint on its pre-build size estimate. Best-effort: a missing directory (e.g. no assets/ yet) just doesn't contribute, same as GET /estimate-size's own missing-dist handling. */
function isBuildStale(builtAtMs) {
  let newest = 0;
  for (const dir of [SRC_DIR, path.join(ROOT, "assets")]) {
    try {
      newest = Math.max(newest, newestMtimeMs(dir));
    } catch {
      // missing dir — nothing to contribute
    }
  }
  try {
    newest = Math.max(newest, fs.statSync(path.join(ROOT, "tools", "ui-editor.html")).mtimeMs);
  } catch {
    // missing file — nothing to contribute
  }
  return newest > builtAtMs;
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
// method's "{…}" placeholder, or `\n`, a plain line break) has to stay
// unconsumed so the *next* field right after it can still anchor on the
// same boundary. A consuming `(?:^|;)` here would eat each field's own
// trailing `;` as it matched, leaving nothing for the next field to
// anchor on and silently dropping every field after the first in a
// class. `\n` is in the accepted set (safe here specifically because
// this only ever runs against a class body with every nested block
// already blanked out — see extractClasses' maskedForFields — so the
// only things a bare newline could be separating are field declarations,
// blank lines, or masked-out former comments, never mid-expression
// content) because a field written without its own trailing semicolon
// (valid TS via ASI — this codebase has a few) still needs to hand off a
// real boundary to whatever comes after it once its own match stops at
// that same newline instead of hunting for a literal `;`.
//
// [^=;{}\n] / [^;\n] — bounded against \n on both the type and
// initializer captures, and the terminator accepts a lookahead newline/
// EOF as an alternative to a literal `;`, for exactly the same reason:
// without the \n exclusion, a field missing its semicolon let the old
// version of this regex run right past its own line hunting for the
// next `;` *anywhere later in the class* — silently swallowing (and,
// worse, hiding from every /script-info consumer — the Scripts panel,
// the Engine Room's Control Desk, Header() grouping) every field in
// between. Confirmed happening for real: `private me!: THREE.Group` (no
// trailing `;`) in Player.ts made `time` vanish from the listing
// entirely even though it was never touched on disk.
//
// [?!] — either the optional marker (`x?: T`, may never be assigned) or
// TS's definite-assignment assertion (`x!: T`, "trust me, something else
// assigns this before it's ever read" — e.g. a constructor calling an
// init helper the type checker can't trace into). Different meanings,
// same syntactic slot; extractClasses below only treats a bare `?` as
// contributing to the static "assigned" flag — see its own comment.
// "d" flag (match.indices) — the leading `\s*` right after the lookbehind
// can span backward across an entire blank-line/masked-comment region
// (including a Header() comment sitting there) before reaching the
// actual field name, so `match.index` (the whole match's start) is *not*
// a reliable stand-in for "where this field's name token is" — see
// extractClasses' header-assignment loop, which needs the real one to
// correctly tell "this header is above field A" from "this header is
// above field B" instead of crediting it to whichever field's `\s*`
// happened to reach back far enough to include it.
const PUBLIC_FIELD_PATTERN = /(?<=^|;|\}|\n)\s*(?:(private|protected|public)\s+)?(readonly\s+)?([\w$]+)\s*([?!])?\s*(?::\s*([^=;{}\n]+?))?\s*(=\s*([^;\n]+?))?\s*(?:;|(?=\n|$))/gd;

/**
 * Unity-[Header]-style section divider for the Engine Room's Control Desk
 * — a plain `// Header("Section name")` comment placed directly above one
 * or more field declarations groups everything below it (down to the
 * next Header, or the end of the class) under that heading, rendered as
 * a labeled divider in the panel. No real decorator/metadata involved —
 * this is a lightweight regex tool working off text, not a type checker,
 * so a comment is the natural (and zero-runtime-cost) place for it.
 */
const HEADER_PATTERN = /\/\/\s*Header\(\s*(['"`])(.*?)\1\s*\)/g;

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
        // header: null — Header() grouping only applies to plain field
        // declarations below (Unity's [Header] groups serialized fields,
        // not constructor arguments); kept here only so every field
        // object has the same shape regardless of kind.
        fields.push({ name, type: type.trim(), assigned: !!defaultValue || !!optional, kind: "constructor-param", visibility: visibility || "public", header: null });
      }
    }

    // Plain field declarations — scanned over the class body with every
    // nested block blanked out first (see blankNestedBraces), so this
    // only ever matches direct members, never something inside a method.
    // Every visibility collected here too, same reason as above.
    //
    // Headers live inside comments, and `body` above came from
    // stripComments' output — comments are gone by this point, deleted
    // outright (not blanked to spaces), so there's nothing left here to
    // find a Header in. Re-slice the *raw*, comment-intact class body
    // instead (findClassBodySpan does its own brace-counting directly on
    // rawSourceText, same helper the Save endpoint uses) and mask
    // comments/strings to same-length whitespace (maskCommentsAndStrings)
    // rather than deleting them — deletion would shift every offset after
    // it, which is exactly what breaks correlating a header's position
    // with the fields that follow it. Masking preserves length, so a
    // header match's index and a field match's index, both taken from
    // this same masked text, stay directly comparable.
    const rawSpan = findClassBodySpan(rawSourceText, className);
    const rawBody = rawSpan ? rawSourceText.slice(rawSpan.start, rawSpan.end) : body;
    const blankedRaw = blankNestedBraces(rawBody);
    // blankMethodSignatures runs on top of the comment-masked view (not
    // the reverse) so its own paren-depth counting can't be thrown off by
    // a stray `(`/`)` sitting inside a comment.
    const maskedForFields = blankMethodSignatures(maskCommentsAndStrings(blankedRaw));

    const headerMatches = [...blankedRaw.matchAll(HEADER_PATTERN)].map((hm) => ({ index: hm.index, text: hm[2].trim() }));
    let headerCursor = 0;
    let currentHeader = null;

    PUBLIC_FIELD_PATTERN.lastIndex = 0;
    let fieldMatch;
    while ((fieldMatch = PUBLIC_FIELD_PATTERN.exec(maskedForFields))) {
      const [, visibility, , name, marker, type, , initializer] = fieldMatch;
      if (name === "constructor") continue; // never a real match (constructor has no trailing `;` right after its `{…}`), but skip defensively
      const namePos = fieldMatch.indices[3][0]; // real position of the name token — see PUBLIC_FIELD_PATTERN's own comment for why fieldMatch.index itself isn't safe to use here
      while (headerCursor < headerMatches.length && headerMatches[headerCursor].index < namePos) {
        currentHeader = headerMatches[headerCursor].text;
        headerCursor++;
      }
      fields.push({
        name,
        type: type ? type.trim() : null,
        // `?` (optional) reads as "already has a real default" for this
        // flag's purposes, same as an explicit initializer. `!` (definite
        // assignment assertion) means the *opposite* by declaration —
        // "not assigned here, something else assigns it later" — so it
        // does NOT count on its own; the Engine Room's Control Desk shows
        // the truthful live-assigned state once an instance actually
        // exists anyway (see renderField's `live ? value !== undefined :
        // field.assigned` in index.html), this static flag is only
        // ever a best guess for before that.
        assigned: !!initializer || marker === "?",
        kind: "field",
        visibility: visibility || "public",
        header: currentHeader,
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

/**
 * Backing /save-inspectable-values (the Engine Room's Control Desk 💾
 * Save button) — writes a live-tweaked field value back into the actual
 * .ts source as that field's new default, so it survives past the current
 * run instead of only living in the in-memory instance until the next
 * reload. Deliberately narrow: a small regex-scoped patch of just the one
 * field's declaration/assignment (on real source text, not a real AST
 * rewrite) — see maskCommentsAndStrings below for how it stays safe
 * against false matches inside comments/string literals anyway. Only ever
 * called with number/boolean values (see the Engine Room's
 * collectEditableFields) — literalFor rejects anything else, including
 * non-finite numbers (NaN/Infinity are valid *identifiers* in TS, so a
 * naive String(value) would happily write `= NaN;` into a source file
 * without erroring), so a bad payload fails loudly instead of writing
 * something meaningless into a source file.
 */
function literalFor(value) {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error("Unsupported value for save: " + value);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Length-preserving comment/string-literal blanker — every character
 * inside a `//`/`/* *‍/` comment or a `"…"`/`'…'`/`\`…\`` literal becomes a
 * space (newlines stay newlines), everything else passes through
 * unchanged. Unlike stripComments above (which drops characters and is
 * fine for extractClasses' read-only field listing), every index in the
 * result lines up 1:1 with the same index in the original — so the patch
 * functions below can match against *this* (guaranteeing they can never
 * mistake a field-shaped fragment sitting inside a comment or a string
 * literal type, e.g. `label: "circle" | "square"`, for a real
 * declaration) while still reporting offsets valid against the real text.
 */
function maskCommentsAndStrings(text) {
  let result = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") {
        result += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      result += "  ";
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        result += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        result += "  ";
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      result += " ";
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === "\\" && i + 1 < n) {
          result += "  ";
          i += 2;
          continue;
        }
        result += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        result += " ";
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
 * blankNestedBraces collapses a method/constructor/getter *body* down to
 * a 3-character "{…}" placeholder, but leaves its *signature* (name,
 * parameter list, optional return type) as real text — and a multi-line
 * parameter list (`constructor(\n  scene: THREE.Scene,\n  ...)`) is
 * indistinguishable from a run of field declarations to
 * PUBLIC_FIELD_PATTERN once a bare newline counts as a valid boundary
 * (needed there for a different reason — see that pattern's own
 * comment). Used only for extractClasses' plain-field scan: finds every
 * `name(...) ... {…}` shape blankNestedBraces left behind and blanks the
 * whole thing (signature included) to same-length whitespace, so nothing
 * method-shaped survives for the field scanner to mistake for a
 * declaration. Constructor parameter *properties* are unaffected — those
 * are read straight out of the constructor's own parameter list by a
 * separate, earlier pass in extractClasses, before this ever runs.
 */
const METHOD_MODIFIER_KEYWORDS = new Set(["get", "set", "static", "async", "private", "protected", "public", "readonly", "override", "abstract"]);

function blankMethodSignatures(text) {
  let result = "";
  let i = 0;
  const n = text.length;
  const idStart = /[A-Za-z_$]/;
  const idPart = /[\w$]/;
  while (i < n) {
    if (idStart.test(text[i])) {
      // Walk through zero or more leading modifier keywords (`get`, `set`,
      // `static`, `private`, ...) — `get position(): T {…}` would
      // otherwise leave the "get" name blanking check to fail (it's not
      // itself followed by `(`) *and* the field scanner mistake bare
      // "get" for a valueless field once it's the only thing left
      // standing. `j` ends up pointing past whichever identifier turns
      // out to actually be the method name.
      let cur = i;
      let j = i;
      for (;;) {
        let end = cur + 1;
        while (end < n && idPart.test(text[end])) end++;
        const word = text.slice(cur, end);
        let k = end;
        while (k < n && /\s/.test(text[k])) k++;
        if (METHOD_MODIFIER_KEYWORDS.has(word) && idStart.test(text[k] || "")) {
          cur = k;
          continue;
        }
        j = k;
        break;
      }
      if (text[j] === "(") {
        const k = j;
        let depth = 1;
        let m = k + 1;
        for (; m < n && depth > 0; m++) {
          if (text[m] === "(") depth++;
          else if (text[m] === ")") depth--;
        }
        let p = m;
        while (p < n && /\s/.test(text[p])) p++;
        if (text[p] === ":") {
          p++;
          while (p < n && text[p] !== "{" && text[p] !== "\n") p++;
        }
        while (p < n && /\s/.test(text[p])) p++;
        if (text.startsWith("{…}", p)) {
          const end = p + 3;
          for (let q = i; q < end; q++) result += text[q] === "\n" ? "\n" : " ";
          i = end;
          continue;
        }
      }
    }
    result += text[i];
    i++;
  }
  return result;
}

/** Finds `re`'s first match against the masked (comment/string-safe) view of `text`, then re-runs the same regex against the *real* substring at that exact span so captured groups (type text, etc.) come from the genuine source, never blanked-out placeholder spaces. Returns null if there's no match, or in the vanishingly unlikely case the real substring doesn't re-match its own already-known span (would mean the masked and real text disagree in a way that shouldn't be possible). */
function matchOnRealText(text, re) {
  const masked = maskCommentsAndStrings(text);
  const m = re.exec(masked);
  if (!m) return null;
  const real = text.slice(m.index, m.index + m[0].length);
  const reMatch = re.exec(real); // none of these regexes carry the "g" flag, so this always scans from 0 regardless of any prior lastIndex
  if (!reMatch || reMatch.index !== 0) return null;
  reMatch.index = m.index;
  return reMatch;
}

/** Same class-boundary brace-counting as extractClasses, but run directly over raw (un-stripped) source — via matchOnRealText for the header itself — so the returned span's indices are valid offsets into the exact text about to be written back to disk. */
function findClassBodySpan(rawText, className) {
  const re = new RegExp("\\bclass\\s+" + escapeRegExp(className) + "\\b[^{]*\\{");
  const m = matchOnRealText(rawText, re);
  if (!m) return null;
  const bodyStart = m.index + m[0].length;
  let depth = 1;
  let i = bodyStart;
  for (; i < rawText.length && depth > 0; i++) {
    if (rawText[i] === "{") depth++;
    else if (rawText[i] === "}") depth--;
  }
  return { start: bodyStart, end: i - 1 };
}

/**
 * A class-field initializer (`readonly bound: number = 5;`) runs *before*
 * the constructor body — so if that body also does `this.bound = ...`
 * (common for anything computed from constructor params, e.g. World.bound
 * from `size`), the initializer never actually takes effect; it's
 * immediately overwritten. Patching the declaration in that case would
 * "succeed" while silently changing nothing at runtime. This finds that
 * assignment inside the constructor body specifically (not just anywhere
 * in the class — a same-named assignment in some other method shouldn't
 * match), so the caller can prefer patching *that* over the declaration
 * whenever one exists — for both a plain field and a constructor-param
 * property (which can still be reassigned by hand inside the body even
 * though its *initial* value is compiler-synthesized).
 */
function patchConstructorAssignment(body, fieldName, literal) {
  const ctorRe = /constructor\s*\([\s\S]*?\)\s*(?::[^{]+)?\{/;
  const cm = matchOnRealText(body, ctorRe);
  if (!cm) return null;
  const ctorBodyStart = cm.index + cm[0].length;
  let depth = 1;
  let i = ctorBodyStart;
  for (; i < body.length && depth > 0; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") depth--;
  }
  const ctorBodyEnd = i - 1;
  const ctorBody = body.slice(ctorBodyStart, ctorBodyEnd);
  // The value expression is bounded to a single line (`[^;\n]+?`, same
  // reasoning as patchFieldDeclaration below) and its end accepts a
  // newline via lookahead as well as a literal `;` — TS's own ASI treats
  // both as a valid statement end. Without the \n exclusion, a
  // *different* nearby statement missing its semicolon (this codebase
  // has a few, tsc doesn't require it) would let `[^;]+?` run right past
  // the intended line hunting for the next `;` anywhere in the
  // constructor, silently swallowing and then deleting everything in
  // between when the match gets replaced.
  const assignRe = new RegExp("\\bthis\\." + escapeRegExp(fieldName) + "\\s*=\\s*[^;\\n]+?\\s*(?:;|(?=\\n|$))");
  const am = matchOnRealText(ctorBody, assignRe);
  if (!am) return null;
  return { start: ctorBodyStart + am.index, end: ctorBodyStart + am.index + am[0].length, replacement: "this." + fieldName + " = " + literal + ";" };
}

/**
 * Patches a plain field declaration (`name: type;` or `name: type = old;`,
 * any visibility/readonly combination) inside a class body slice, forcing
 * in `literal` as its new initializer. Returns null if no such declaration
 * is found (e.g. the field only exists as a constructor-param property —
 * see below). Prefer patchConstructorAssignment first when the field
 * might be reassigned in the constructor body — see its own doc comment.
 *
 * The initializer capture `[^;\n]+?` — and the terminator accepting a
 * bare newline via lookahead, not just a literal `;` — matter more than
 * they look: this codebase has fields written without a trailing
 * semicolon (`public time: number = 0`, valid TS via ASI). Without the
 * `\n` exclusion, that missing `;` let the *old* version of this regex
 * treat everything up to the next semicolon *anywhere later in the
 * class* as this field's own initializer — including entire unrelated
 * field declarations — which then vanished the moment the match got
 * replaced. Confirmed and fixed after exactly that happened to a real
 * file (see the conversation this was fixed in).
 */
function patchFieldDeclaration(body, fieldName, literal) {
  const escaped = escapeRegExp(fieldName);
  // [?!]? — same as PUBLIC_FIELD_PATTERN above: either the optional marker
  // or a definite-assignment assertion.
  const re = new RegExp("((?:private|protected|public)\\s+)?(readonly\\s+)?\\b" + escaped + "\\b([?!]?)\\s*:\\s*([^=;{}\\n]+?)\\s*(?:=\\s*([^;\\n]+?))?\\s*(?:;|(?=\\n|$))");
  const m = matchOnRealText(body, re);
  if (!m) return null;
  const [full, vis, ro, opt, type] = m;
  // `?` is echoed back unchanged — `x?: number = 5;` is perfectly valid
  // TS. `!` is dropped, not echoed: TS hard-errors (TS1263) on a
  // definite-assignment assertion combined with an initializer, and once
  // we're writing in a real value the assertion ("something else is
  // responsible for assigning this") is exactly what's no longer true.
  const marker = opt === "?" ? "?" : "";
  const replacement = (vis || "") + (ro || "") + fieldName + marker + ": " + type.trim() + " = " + literal + ";";
  return { start: m.index, end: m.index + full.length, replacement };
}

/** Same idea as patchFieldDeclaration, but for a constructor-parameter property (`constructor(private readonly speed: number = 4.5)`) — the field never appears in the class body itself, only in the constructor's own parameter list. */
function patchCtorParamDeclaration(body, fieldName, literal) {
  const ctorRe = /constructor\s*\(([\s\S]*?)\)\s*(?::[^{]+)?\{/;
  const cm = matchOnRealText(body, ctorRe);
  if (!cm) return null;
  const params = cm[1];
  const paramsStart = cm.index + cm[0].indexOf(params);
  const escaped = escapeRegExp(fieldName);
  const fieldRe = new RegExp("((?:private|protected|public)\\s+)?(readonly\\s+)?\\b" + escaped + "\\b(\\??)\\s*:\\s*([^=,)]+?)\\s*(?:=\\s*([^,)]+?))?\\s*(?=[,)])");
  const fm = matchOnRealText(params, fieldRe);
  if (!fm) return null;
  const [full, vis, ro, opt, type] = fm;
  const replacement = (vis || "") + (ro || "") + fieldName + (opt || "") + ": " + type.trim() + " = " + literal;
  return { start: paramsStart + fm.index, end: paramsStart + fm.index + full.length, replacement };
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

/**
 * Writes a file the way a save should be written: all of it, or none of it.
 *
 * Every one of these targets is a real source file in the client's repository
 * — colliders.json, the UI layouts, a .ts the Control Desk is patching. A
 * plain writeFileSync truncates first and writes second, so a process killed
 * between the two (Ctrl+C on the dev server, a full disk, a crash) leaves a
 * zero-length or half-written file where the client's work used to be, and the
 * next boot fails to parse it.
 *
 * Writing a sibling temp file and renaming over the target is atomic on every
 * platform this runs on: the target is either the old content or the new one,
 * never a prefix of either. The temp file is a sibling specifically because
 * rename is only atomic within one filesystem.
 */
function writeFileAtomic(targetPath, contents) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, contents);
    fs.renameSync(temp, targetPath);
  } catch (err) {
    // Never leave the temp file behind to be mistaken for a real one.
    try { fs.rmSync(temp, { force: true }); } catch { /* nothing more to do */ }
    throw err;
  }
}

/** The same, for the JSON every editor saves. */
function writeJsonAtomic(targetPath, data) {
  writeFileAtomic(targetPath, JSON.stringify(data, null, 2) + "\n");
}

function writeBindings(data) {
  writeJsonAtomic(BINDINGS_FILE, data);
}

function readSceneBindings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SCENE_BINDINGS_FILE, "utf8"));
    if (!Array.isArray(parsed.bindings)) throw new Error("malformed");
    return parsed;
  } catch {
    return { version: 1, bindings: [] };
  }
}
function writeSceneBindings(data) {
  writeJsonAtomic(SCENE_BINDINGS_FILE, data);
}

function readColliders() {
  try {
    const parsed = JSON.parse(fs.readFileSync(COLLIDERS_FILE, "utf8"));
    if (!Array.isArray(parsed.colliders)) throw new Error("malformed");
    return parsed;
  } catch {
    return { version: 1, colliders: [] };
  }
}
function writeColliders(data) {
  writeJsonAtomic(COLLIDERS_FILE, data);
}

function readParticles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PARTICLES_FILE, "utf8"));
    if (!Array.isArray(parsed.systems)) throw new Error("malformed");
    return parsed;
  } catch {
    return { version: 1, systems: [] };
  }
}
function writeParticles(data) {
  writeJsonAtomic(PARTICLES_FILE, data);
}

function readEnvironment() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ENVIRONMENT_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("malformed");
    return parsed;
  } catch {
    // The runtime loader fills every missing field from its own defaults
    // (see loadSceneEnv), so an empty object is a valid answer here rather
    // than an error — a project that has never opened the panel simply has
    // no file yet.
    return { version: 1 };
  }
}
function writeEnvironment(data) {
  writeJsonAtomic(ENVIRONMENT_FILE, data);
}

function readScene() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SCENE_FILE, "utf8"));
    if (!Array.isArray(parsed.objects)) throw new Error("malformed");
    return parsed;
  } catch {
    // A project that has never moved anything in the editor has no file yet,
    // and an empty override set is exactly what that means.
    return { version: 1, objects: [] };
  }
}
function writeScene(data) {
  writeJsonAtomic(SCENE_FILE, data);
}

// Vite's dev server prints both of these as the "Local" URL depending on
// platform/version, and either is a completely normal way to end up
// browsing the page — the CORS origin allowed here has to match whichever
// one the tab is actually on, or the browser silently discards the
// response and the button just reads "API offline" for no visible reason.
//
// ION_DEV_ORIGINS (comma-separated) widens this for a generated project,
// whose Vite server may well not be on 8000 — `ion dev` sets it to whatever
// port it actually bound. The 8000 pair stays the default so this repo's own
// dev mode is unaffected.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  ...(process.env.ION_DEV_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
]);

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
    // `root` is here so the readout can say *which project answered*. The
    // panel reaches this API by origin alone, and an origin is not an
    // identity: an orphaned dev API from a deleted project holds its port
    // just as well as a live one, and answers just as confidently. That
    // exact case produced a version pill showing a version this checkout
    // never had and a commit that is not an object in its repository.
    res.end(JSON.stringify({ version: ionVersion(), projectVersion: projectVersion(), root: ROOT, ...readGitInfo() }));
    return;
  }

  if (req.method === "GET" && req.url === "/estimate-size") {
    // Backs the Builder panel's size bar *before* you actually click Build
    // — the last real dist/index.html on disk (from whenever it was last
    // built), not a guess computed from current source — so it's exact as
    // of that build, and honestly labeled stale (see `stale` below) the
    // moment anything under src/, tools/ui-editor.html, or assets/ changes
    // more recently than that.
    res.setHeader("Content-Type", "application/json");
    const distPath = path.join(ROOT, "dist", "index.html");
    try {
      const stat = fs.statSync(distPath);
      const stale = isBuildStale(stat.mtimeMs);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, exists: true, sizeBytes: stat.size, builtAtMs: stat.mtimeMs, stale }));
    } catch {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, exists: false }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/build-report") {
    // dist/build-report.json is written by build.sh's own final python
    // block (merging scripts/compress-assets.mjs's per-asset compression
    // stats with the real inlined/gzip/total sizes) — this just hands that
    // file to the Builder panel's "📊 Build Report" button as-is. Same
    // stale/exists shape as /estimate-size above, for the same reason: the
    // panel needs to tell "no build yet" apart from "built, but source has
    // changed since."
    res.setHeader("Content-Type", "application/json");
    const reportPath = path.join(ROOT, "dist", "build-report.json");
    try {
      const stat = fs.statSync(reportPath);
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, exists: true, stale: isBuildStale(stat.mtimeMs), report }));
    } catch {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, exists: false }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/build") {
    // The command itself is fixed, version-controlled, never built from the
    // request — no injection surface regardless of who can reach this port.
    // The Builder panel's "Half Float" checkbox is the one build parameter
    // the request body carries, and it only ever reaches build.sh through
    // `env` below (a value, not shell text) — see
    // scripts/compress-assets.mjs for what it actually toggles.
    readRequestBody(req, 1024)
      .then((raw) => {
        let halfFloat = true; // best-compression default, matching a plain `npm run build`'s own default
        try {
          const parsed = raw ? JSON.parse(raw) : {};
          if (typeof parsed.halfFloat === "boolean") halfFloat = parsed.halfFloat;
        } catch {
          // malformed/absent body — keep the default rather than failing the build over it
        }
        // ION_BUILD_SCRIPT is set by `ion dev` and points into the installed
        // @ion-engine/build. Without it — ION's own repo — the pipeline is
        // right here, which is what the fallback covers. A generated project
        // has no build.sh of its own, so assuming one is what made the
        // Builder button fail there while `npm run build` worked.
        const buildScript = process.env.ION_BUILD_SCRIPT || path.join(ROOT, "build.sh");
        if (!fs.existsSync(buildScript)) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: `Build pipeline not found at ${buildScript}. Start the dev server with \`npm run dev\` so it can locate @ion-engine/build.` }));
          return;
        }
        // execFile, not exec: the path is a real filesystem path that may
        // contain spaces, and there is no reason to hand it to a shell.
        execFile(
          "bash",
          [buildScript],
          { cwd: ROOT, timeout: 120000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, HALF_FLOAT: halfFloat ? "1" : "0" } },
          (err, stdout, stderr) => {
            res.setHeader("Content-Type", "application/json");

            // build.sh's final step is scripts/check-build-report.mjs, which
            // exits 2 for "built, but not submittable" — a non-empty
            // compatibilityWarnings, or an over-budget artifact. That is a
            // genuinely different outcome from a build failure and must not
            // be reported as one: dist/index.html, the report and the zip
            // were all written before the check ran, so every number the
            // Builder panel shows is real and worth showing. Anything else
            // non-zero is a real failure with nothing to paint.
            const notSubmittable = !!err && err.code === 2;
            if (err && !notSubmittable) {
              res.writeHead(500);
              res.end(JSON.stringify({ ok: false, error: err.message, stdout, stderr }));
              return;
            }

            // build.sh prints this on its own final line once dist/index.html is
            // written — parsed straight from stdout rather than re-stat-ing the
            // file here so the reported size is exactly the bytes build.sh itself
            // just measured, not a second, possibly-racy read.
            const sizeMatch = stdout.match(/BUILD_SIZE_BYTES=(\d+)/);
            const sizeBytes = sizeMatch ? Number(sizeMatch[1]) : null;

            // Read back the findings rather than scraping them out of stdout:
            // the report is the same file the "📊 Build Report" button renders,
            // so the panel's flag and its report can't disagree about what was
            // wrong.
            let findings = [];
            let overBudget = false;
            if (notSubmittable) {
              try {
                const report = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", "build-report.json"), "utf8"));
                findings = Array.isArray(report.compatibilityWarnings) ? report.compatibilityWarnings : [];
                overBudget = !!report.overBudget;
              } catch {
                // The gate said the build isn't submittable, so say so even if
                // the report can't be re-read — losing the detail is better
                // than losing the flag.
              }
            }

            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, submittable: !notSubmittable, findings, overBudget, stdout, stderr, sizeBytes }));
          }
        );
      })
      .catch((err) => {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: err.message }));
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

        writeJsonAtomic(targetPath, data);
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        // Forward slashes always, regardless of host OS — this is a JSON API
        // contract read by the browser client (and asserted on by tests), not
        // a path for this process's own fs calls, so it must not vary with
        // path.sep the way path.relative()'s raw output does on Windows.
        res.end(JSON.stringify({ ok: true, path: path.relative(ROOT, targetPath).split(path.sep).join("/") }));
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
    const result = Object.fromEntries(REPORTED_CATEGORIES.map((c) => [c, []]));
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

  if (req.method === "GET" && req.url === "/list-logic-scripts") {
    // Engine Room's Control Desk — live runtime field inspector (see
    // index.html). The inverse filter of /list-scripts above: only
    // src/game/ files OUTSIDE ui/ (gameplay classes — Player, CoinField,
    // World, Game itself — the things with tweakable runtime state), never
    // ui/ (that's Scripts-panel/Bindings territory, not live-tweak
    // territory) and never src/engine/ at all (generic, no game-specific
    // state to tweak).
    const files = [];
    try {
      walkTsFiles(SCRIPT_CATEGORIES.game, SCRIPT_CATEGORIES.game, files);
    } catch {
      // Shouldn't happen (checked into the repo), same reasoning as above.
    }
    const result = files.filter((f) => !f.startsWith("ui/")).sort();
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ category: "game", files: result }));
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

  if (req.method === "POST" && req.url === "/save-inspectable-values") {
    readRequestBody(req, 1024 * 1024)
      .then((raw) => {
        const body = JSON.parse(raw);
        const { category, path: relPath, edits } = body;
        // Only ever "game" in practice (Control Desk never lists src/engine/
        // — see /list-logic-scripts), but resolveScriptPath enforces it's a
        // real category either way, same guard every other file-writing
        // endpoint here uses.
        if (!category || !relPath || !Array.isArray(edits) || !edits.length) throw new Error("Missing category/path/edits");
        const fullPath = resolveScriptPath(category, relPath);
        if (!fullPath) throw new Error("Invalid category/path");

        let source = fs.readFileSync(fullPath, "utf8");
        const applied = [];
        const failed = [];

        // Grouped by class so each class body is only re-sliced out of the
        // (possibly already-patched-by-an-earlier-class) source once, and
        // multiple fields on the same class are patched against the same
        // live body string in sequence — each patch's replacement can
        // shift that body's own length, but never another class's span,
        // since classes never nest in this codebase.
        const byClass = new Map();
        for (const e of edits) {
          if (!byClass.has(e.className)) byClass.set(e.className, []);
          byClass.get(e.className).push(e);
        }

        for (const [className, classEdits] of byClass) {
          const span = findClassBodySpan(source, className);
          if (!span) {
            classEdits.forEach((e) => failed.push(className + "." + e.fieldName));
            continue;
          }
          let bodyText = source.slice(span.start, span.end);
          for (const e of classEdits) {
            let literal;
            try {
              literal = literalFor(e.value);
            } catch {
              failed.push(className + "." + e.fieldName);
              continue;
            }
            // Either kind might still be reassigned by hand somewhere in
            // the constructor body (patchConstructorAssignment's doc
            // comment covers the plain-field case; a constructor-param
            // property's *initial* value is compiler-synthesized so this
            // normally finds nothing for it, but an explicit reassignment
            // later in the same body is still possible and, same as a
            // plain field, would silently shadow a patched default) — try
            // that first either way, only falling back to each kind's own
            // declaration/default when there's no such assignment.
            const patch =
              patchConstructorAssignment(bodyText, e.fieldName, literal) ||
              (e.kind === "constructor-param" ? patchCtorParamDeclaration(bodyText, e.fieldName, literal) : patchFieldDeclaration(bodyText, e.fieldName, literal));
            if (!patch) {
              failed.push(className + "." + e.fieldName);
              continue;
            }
            bodyText = bodyText.slice(0, patch.start) + patch.replacement + bodyText.slice(patch.end);
            applied.push(className + "." + e.fieldName);
          }
          source = source.slice(0, span.start) + bodyText + source.slice(span.end);
        }

        if (applied.length) writeFileAtomic(fullPath, source);
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, applied, failed }));
      })
      .catch((err) => {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
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

  if (req.method === "GET" && req.url === "/list-scene-bindings") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(readSceneBindings()));
    return;
  }

  // Batched on purpose: the editor holds assignments in memory for the
  // whole session and flushes them here in one request when you hit Exit
  // Editor. Writing them one at a time, as they were picked, meant every
  // pick touched a watched source file and hot-reloaded the game out from
  // under the editor session that was making them.
  if (req.method === "POST" && req.url === "/save-scene-bindings") {
    readRequestBody(req, 1024 * 1024)
      .then((raw) => {
        const body = JSON.parse(raw);
        const edits = Array.isArray(body.edits) ? body.edits : [];
        const data = readSceneBindings();
        for (const edit of edits) {
          const { className, fieldName } = edit;
          if (!className || !fieldName) throw new Error("Missing className/fieldName");
          // One binding per class+field either way — assigning over an
          // existing one replaces it rather than stacking a second.
          data.bindings = data.bindings.filter((b) => !(b.className === className && b.fieldName === fieldName));
          if (edit.remove) continue;
          if (!edit.objectPath && !edit.objectName) throw new Error("Missing objectPath/objectName");
          const binding = {
            className,
            fieldName,
            objectPath: edit.objectPath || "",
            objectName: edit.objectName || "",
          };
          // Only present for a field that holds an ION Collider rather than
          // a scene object — a collider can't be found by walking the scene
          // graph, so this is what resolution keys off at boot (see
          // SceneFieldBinding.colliderId). Omitted entirely otherwise, so an
          // ordinary object binding's JSON is unchanged.
          if (edit.colliderId) binding.colliderId = edit.colliderId;
          data.bindings.push(binding);
        }
        writeSceneBindings(data);
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, applied: edits.length, bindings: data.bindings }));
      })
      .catch((err) => {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (req.method === "GET" && req.url === "/list-colliders") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(readColliders()));
    return;
  }

  // A wholesale replace, not a merge: src/game/colliders.json is entirely
  // the 3D editor's to own, and the editor always sends the complete set it
  // holds. Merging would have to reconcile deletions and reorders for no
  // benefit — and a delete that silently didn't stick is a far worse
  // failure than a full overwrite.
  //
  // Batched to one write on Exit Editor for the same reason as
  // /save-scene-bindings above: this file is in main.ts's module graph, so
  // writing it mid-session hot-reloads the scene the editor is editing.
  if (req.method === "POST" && req.url === "/save-colliders") {
    readRequestBody(req, 4 * 1024 * 1024)
      .then((raw) => {
        const body = JSON.parse(raw);
        if (!Array.isArray(body.colliders)) throw new Error("Missing colliders array");
        for (const collider of body.colliders) {
          if (!collider.id || !collider.shape) throw new Error("Every collider needs an id and a shape");
        }
        writeColliders({ version: 1, colliders: body.colliders });
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, saved: body.colliders.length }));
      })
      .catch((err) => {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (req.method === "GET" && req.url === "/list-particles") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(readParticles()));
    return;
  }

  // A wholesale replace and a single batched write on Exit Editor, for
  // exactly the reasons /save-colliders above gives: the file is entirely
  // the editor's to own, and it sits in main.ts's module graph so writing
  // it mid-session hot-reloads the scene being edited.
  //
  // The body limit is larger than the collider one because a particle
  // config is genuinely bigger — sixteen modules per emitter, several
  // emitters per system — while still being small enough that a runaway
  // request can't exhaust memory.
  if (req.method === "POST" && req.url === "/save-particles") {
    readRequestBody(req, 8 * 1024 * 1024)
      .then((raw) => {
        const body = JSON.parse(raw);
        if (!Array.isArray(body.systems)) throw new Error("Missing systems array");
        for (const system of body.systems) {
          if (!system.id || !Array.isArray(system.emitters)) throw new Error("Every system needs an id and an emitters array");
          for (const emitter of system.emitters) {
            if (!emitter.id || !emitter.main) throw new Error(`Emitter in "${system.name || system.id}" is missing an id or its main module`);
          }
        }
        writeParticles({ version: 1, systems: body.systems });
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        const emitters = body.systems.reduce((n, s) => n + s.emitters.length, 0);
        res.end(JSON.stringify({ ok: true, saved: body.systems.length, emitters }));
      })
      .catch((err) => {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (req.method === "GET" && req.url === "/list-scene") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(readScene()));
    return;
  }

  /**
   * The scene graph the 3D editor authored — transforms, visibility, names,
   * parenting — written wholesale to src/game/scene.json.
   *
   * Wholesale, like colliders and particles, because the editor sends the
   * complete diff against the model every time; there is nothing to merge.
   * Batched to Exit for the same reason those two are: the file is a real
   * import in the module graph, so writing it mid-session would hot-reload
   * the scene out from under the editor that is editing it.
   */
  if (req.method === "POST" && req.url === "/save-scene") {
    readRequestBody(req, 4 * 1024 * 1024)
      .then((raw) => {
        const body = JSON.parse(raw);
        if (!Array.isArray(body.objects)) throw new Error("Missing objects array");
        for (const object of body.objects) {
          if (!object || typeof object.objectPath !== "string" || !object.objectPath) {
            throw new Error("Every scene override needs an objectPath");
          }
        }
        writeScene({ version: 1, objects: body.objects });
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, saved: body.objects.length }));
      })
      .catch((err) => {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (req.method === "GET" && req.url === "/list-environment") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(readEnvironment()));
    return;
  }

  // A wholesale replace, same as the two above and for the same reasons.
  // The body is small and fixed-shape (one camera block, one ambient block,
  // a handful of lights, one world block), so the limit is correspondingly
  // tight — there is no legitimate megabyte-sized environment config.
  if (req.method === "POST" && req.url === "/save-environment") {
    readRequestBody(req, 256 * 1024)
      .then((raw) => {
        const body = JSON.parse(raw);
        if (!body.camera || !body.ambient || !body.world) throw new Error("Missing camera, ambient, or world block");
        if (!Array.isArray(body.directionals)) throw new Error("Missing directionals array");
        for (const light of body.directionals) {
          if (!light.id) throw new Error("Every directional light needs an id");
        }
        writeEnvironment({
          version: 1,
          camera: body.camera,
          ambient: body.ambient,
          directionals: body.directionals,
          world: body.world,
        });
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, lights: body.directionals.length }));
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

/**
 * A port already in use is a normal thing to hit, not a crash.
 *
 * Without this handler Node emits an unhandled 'error' event and the process
 * dies with a bare `Error: listen EADDRINUSE` stack trace — no mention of ION,
 * no mention of which project, and nothing to suggest that another ION project
 * already running was the cause. `ion dev` probes for a free port before
 * spawning this (see ports.mjs), so reaching here means something claimed the
 * port in between; saying so is more useful than a stack.
 */
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n✖ ION dev API: port ${PORT} is already in use.`);
    console.error("  Another ION project is probably running. Each one needs its own API port;");
    console.error("  `npm run dev` normally picks a free pair automatically.");
    console.error("  Pass one explicitly with: npm run dev -- --api-port <n>\n");
  } else {
    console.error(`\n✖ ION dev API failed to start: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Dev build API listening on http://127.0.0.1:${PORT} (GET /version, GET /estimate-size, GET /build-report, POST /build, POST /save-layout, GET /load-layout, GET /list-layouts, GET /list-scripts, GET /list-logic-scripts, GET /script-info, POST /save-inspectable-values, GET /list-bindings, POST /save-binding, POST /remove-binding, GET /list-scene-bindings, POST /save-scene-bindings, GET /list-colliders, POST /save-colliders, GET /list-particles, POST /save-particles, GET /list-environment, POST /save-environment)`);
});
