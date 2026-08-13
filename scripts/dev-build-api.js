#!/usr/bin/env node
// Tiny localhost-only HTTP API the dev page's ION Engine panel talks to,
// since a browser can't shell out to build.sh (or git) on its own. Runs
// alongside esbuild's dev server (see scripts/dev.js) — never part of the
// production build, never listens on anything but 127.0.0.1.
const http = require("http");
const { exec, execSync } = require("child_process");
const path = require("path");

const PORT = 8001;
const ROOT = path.join(__dirname, "..");
const PACKAGE_VERSION = require(path.join(ROOT, "package.json")).version;
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

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Dev build API listening on http://127.0.0.1:${PORT} (GET /version, POST /build)`);
});
