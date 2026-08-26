import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadConfig } from "./config.mjs";

/** Serves the built single-file playable, so you can check the real artifact rather than the dev build. */
export async function preview(projectRoot, opts = {}) {
  const config = loadConfig(projectRoot);
  const file = path.join(projectRoot, config.build.outDir, "index.html");
  if (!fs.existsSync(file)) throw new Error(`No build found at ${file}.\n  Run \`ion build\` first.`);
  const port = opts.port ?? config.server.port + 1;
  http
    .createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(fs.readFileSync(file));
    })
    .listen(port, "127.0.0.1", () => {
      const kb = Math.round(fs.statSync(file).size / 1024);
      console.log(`\n  Preview  http://localhost:${port}  (${kb} KB, single file)\n`);
    });
}
