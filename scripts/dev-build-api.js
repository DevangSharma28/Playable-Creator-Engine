#!/usr/bin/env node
// Tiny localhost-only HTTP API two dev-only pages talk to, since a browser
// can't shell out to build.sh/git or write straight into the project on its
// own: the dev page's ION Engine panel (GET /version, POST /build), and
// tools/ui-editor.html's Save/Set-as-Main/Set-as-Endcard/Load, which prefer
// this over the browser's File System Access API whenever it's reachable
// (see /save-layout, /load-layout, /list-layouts below). Runs alongside
// esbuild's dev server (see scripts/dev.js) — never part of the production
// build, never listens on anything but 127.0.0.1.
const http = require("http");
const { exec, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 8001;
const ROOT = path.join(__dirname, "..");
const PACKAGE_VERSION = require(path.join(ROOT, "package.json")).version;
const UI_DIR = path.join(ROOT, "src", "ui");
const LAYOUTS_DIR = path.join(UI_DIR, "layouts");
const ACTIVE_FILES = { main: "mainLayout.json", endcard: "endcardLayout.json" };

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

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Dev build API listening on http://127.0.0.1:${PORT} (GET /version, POST /build, POST /save-layout, GET /load-layout, GET /list-layouts)`);
});
