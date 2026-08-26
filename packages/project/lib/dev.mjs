import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { verifyInstall } from "./integrity.mjs";

/**
 * Resolves an installed ION package's own directory from the project.
 *
 * Goes through `require.resolve` rather than guessing `node_modules/<name>`
 * so it keeps working under pnpm, Yarn PnP-ish layouts, workspaces, and
 * `file:` links — all of which a customer may plausibly be using and none of
 * which put the package where a naive join would look.
 */
function packageDir(projectRoot, name) {
  const require = createRequire(path.join(projectRoot, "package.json"));
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

/** The file a bare specifier resolves to *from the project*, honouring the package's exports map. */
function packageEntry(projectRoot, name) {
  const require = createRequire(path.join(projectRoot, "package.json"));
  try {
    return require.resolve(name);
  } catch {
    return null;
  }
}

/**
 * The Vite plugin that turns a plain project directory into ION Studio.
 *
 * The Studio's page lives in @ion-engine/editor, *outside* the Vite root. It
 * is served through middleware and run back through `transformIndexHtml` so
 * Vite still rewrites its `<script type="module" src="/src/main.ts">` into the
 * project's own entry, injects the HMR client, and processes it exactly as if
 * it had been a file in the root. Copying it into the project instead would
 * put editor implementation in the customer's tree — which is the whole thing
 * this architecture exists to prevent.
 */
function ionStudio({ studioDir, apiOrigin }) {
  const page = path.join(studioDir, "engine-room.html");
  return {
    name: "ion:studio",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? "/").split("?")[0];

        // Studio-owned pages, served straight off the package.
        if (url === "/ui-editor.html" || url === "/guide.css" || /^\/guide[a-z-]*\.html$/.test(url)) {
          const file = path.join(studioDir, path.basename(url));
          if (fs.existsSync(file)) {
            res.setHeader("Content-Type", url.endsWith(".css") ? "text/css" : "text/html");
            res.end(fs.readFileSync(file));
            return;
          }
        }

        if (url !== "/" && url !== "/index.html") return next();

        let html = fs.readFileSync(page, "utf8");
        // Injected ahead of the Engine Room's own script, which reads both of
        // these. The API origin has to be told, not assumed: a second project
        // running at the same time will not have got port 8001.
        html = html.replace(
          "<head>",
          `<head>\n  <script>window.__ION_API_ORIGIN=${JSON.stringify(apiOrigin)};window.__ION_STUDIO_BASE="";window.__ION_DEV__=true;</script>`
        );
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(url, html, req.originalUrl));
      });
    },
  };
}

/** Mirrors assets/ into public/assets so the dev server can serve them by the same relative paths the production build inlines. */
function syncAssets(projectRoot) {
  const from = path.join(projectRoot, "assets");
  const to = path.join(projectRoot, "public", "assets");
  if (!fs.existsSync(from)) return 0;
  let n = 0;
  const copy = (a, b) => {
    const stat = fs.statSync(a);
    if (stat.isDirectory()) {
      fs.mkdirSync(b, { recursive: true });
      for (const e of fs.readdirSync(a)) copy(path.join(a, e), path.join(b, e));
    } else {
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.copyFileSync(a, b);
      n++;
    }
  };
  copy(from, to);
  return n;
}

export async function dev(projectRoot, opts = {}) {
  const config = loadConfig(projectRoot);
  const port = opts.port ?? config.server.port;
  const apiPort = opts.apiPort ?? config.server.apiPort;
  const apiOrigin = `http://127.0.0.1:${apiPort}`;

  const editorDir = packageDir(projectRoot, "@ion-engine/editor");
  if (!editorDir) throw new Error("@ion-engine/editor is not installed.\n  Run `npm install` — ION Studio is a devDependency of this project.");
  const studioDir = path.join(editorDir, "studio");
  if (!fs.existsSync(path.join(studioDir, "engine-room.html"))) {
    throw new Error(`@ion-engine/editor is installed but its studio payload is missing (${studioDir}).\n  Reinstall it: npm install --force @ion-engine/editor`);
  }

  // Surfaced, never enforced: an edit inside node_modules is invisible to git
  // and disappears on the next clean install, so saying so now is the only
  // chance the developer gets to notice.
  for (const result of verifyInstall(projectRoot)) {
    if (result.modified.length || result.missing.length) {
      console.warn(`\n⚠ ${result.name} has been modified inside node_modules:`);
      for (const f of [...result.modified, ...result.missing].slice(0, 5)) console.warn(`    ${f}`);
      console.warn("  Engine code is not part of your project. These edits are not tracked by git,");
      console.warn("  cannot be committed or pushed, and will be lost on the next `npm install`.");
      console.warn("  Restore them with: npm install --force\n");
    }
  }

  const apiScript = path.join(packageDir(projectRoot, "@ion-engine/build") ?? "", "lib", "dev-build-api.cjs");
  let api;
  if (fs.existsSync(apiScript)) {
    api = spawn(process.execPath, [apiScript], {
      cwd: projectRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        ION_PROJECT_ROOT: projectRoot,
        ION_API_PORT: String(apiPort),
        ION_DEV_ORIGINS: `http://localhost:${port},http://127.0.0.1:${port}`,
      },
    });
  }

  const copied = syncAssets(projectRoot);

  // Vite refuses to serve files outside its root unless told otherwise. A
  // normal registry install lives under the project and needs nothing here,
  // but a `file:`-linked package (how ION is consumed pre-publish, and how a
  // monorepo consumes it) resolves to a path outside — and the failure is
  // opaque: the editor's dynamic import 404s, main.ts's await throws, and the
  // game never boots at all, with only "Failed to fetch dynamically imported
  // module" to go on.
  const allow = [projectRoot];
  for (const name of ["@ion-engine/runtime", "@ion-engine/editor"]) {
    const dir = packageDir(projectRoot, name);
    if (dir) allow.push(dir);
  }

  // Resolve the shared packages *from the project* and pin them by absolute
  // path. Two problems this solves, both of which present as baffling:
  //
  //  - A linked @ion-engine/editor resolves its own `@ion-engine/runtime`
  //    import relative to itself, outside the project, and simply can't find
  //    it — the dynamic import 500s and the game never boots.
  //  - Two copies of three.js in one page make `instanceof` fail across the
  //    boundary, so a mesh built by the game isn't a mesh to the editor. The
  //    engine already avoids `instanceof` for exactly this reason, but there
  //    is no need to invite the problem.
  // Pinned by absolute path so a linked package resolves the *project's*
  // copy. Only bare specifiers appear in the artifacts (see the build's
  // external-bare plugin), so no pattern is needed here.
  const alias = [];
  for (const name of ["@ion-engine/runtime", "three"]) {
    const entry = packageEntry(projectRoot, name);
    if (entry) alias.push({ find: new RegExp(`^${name.replace("/", "\\/")}$`), replacement: entry });
  }

  const { createServer } = await import("vite");
  const server = await createServer({
    root: projectRoot,
    configFile: false,
    resolve: { alias, dedupe: ["three", "@ion-engine/runtime"] },
    server: { port, strictPort: true, host: "127.0.0.1", fs: { allow } },
    // The three files the ION editors write are real imports in the module
    // graph, so watching them would hot-reload the very scene being edited
    // the instant you pressed Save.
    optimizeDeps: { exclude: ["@ion-engine/runtime", "@ion-engine/editor"] },
    plugins: [ionStudio({ studioDir, apiOrigin })],
  });
  server.watcher.unwatch([
    path.join(projectRoot, "src/game/colliders.json"),
    path.join(projectRoot, "src/game/particles.json"),
    path.join(projectRoot, "src/game/environment.json"),
  ]);
  await server.listen();

  console.log(`\n  ION Studio   http://localhost:${port}`);
  console.log(`  project      ${config.name} v${config.version}  (ION ${config.ionVersion}, ${config.target})`);
  console.log(`  dev API      ${apiOrigin}`);
  if (copied) console.log(`  assets       ${copied} file(s) synced to public/assets`);
  console.log("");

  const shutdown = () => {
    api?.kill();
    server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
