import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadConfig, CONFIG_NAME } from "./config.mjs";
import { verifyInstall } from "./integrity.mjs";

const MIN_NODE = 20;

/** @returns {number} count of problems found */
export function doctor(projectRoot) {
  const problems = [];
  const notes = [];
  const ok = [];

  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE) problems.push(`Node ${process.versions.node} is too old — ION needs ${MIN_NODE} or newer.`);
  else ok.push(`Node ${process.versions.node}`);

  let config;
  try {
    config = loadConfig(projectRoot);
    ok.push(`${CONFIG_NAME} valid — ${config.name} v${config.version}, target ${config.target}`);
  } catch (err) {
    problems.push(err.message);
  }

  const require = createRequire(path.join(projectRoot, "package.json"));
  for (const name of ["@ion-engine/runtime", "@ion-engine/editor", "@ion-engine/build", "@ion-engine/project"]) {
    try {
      const dir = path.dirname(require.resolve(`${name}/package.json`));
      const installed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
      if (config && name === "@ion-engine/runtime" && installed !== config.ionVersion) {
        // Worth saying out loud rather than silently tolerating: the config is
        // what an upgrade path keys off, and a drifted value makes any future
        // migration step target the wrong release.
        notes.push(`${name} is ${installed} but ${CONFIG_NAME} says ionVersion ${config.ionVersion}. Update the config, or reinstall to match.`);
      }
      ok.push(`${name} ${installed}`);
    } catch {
      problems.push(`${name} is not installed. Run \`npm install\`.`);
    }
  }

  if (!fs.existsSync(path.join(projectRoot, "src", "game", "Game.ts"))) {
    problems.push("src/game/Game.ts is missing — that's the one file every ION project must have.");
  }
  if (fs.existsSync(path.join(projectRoot, "src", "engine"))) {
    notes.push("src/engine/ exists in this project. ION is consumed as a package now; a local copy will shadow nothing but will confuse everyone. Consider deleting it.");
  }

  for (const result of verifyInstall(projectRoot)) {
    if (result.unverifiable) notes.push(`${result.name} has no integrity manifest — can't verify it wasn't modified.`);
    else if (result.modified.length || result.missing.length) {
      problems.push(
        `${result.name} has been modified inside node_modules (${result.modified.length} changed, ${result.missing.length} missing).\n` +
          `    Engine code is not yours to edit: it is git-ignored, unpushable, and replaced on install.\n` +
          `    Restore with: npm install --force`
      );
    } else ok.push(`${result.name} intact (${result.checked} files verified)`);
  }

  console.log("");
  for (const line of ok) console.log(`  ✓ ${line}`);
  for (const line of notes) console.log(`  • ${line}`);
  for (const line of problems) console.log(`  ✖ ${line}`);
  console.log(problems.length ? `\n${problems.length} problem(s) found.\n` : "\nNo problems found.\n");
  return problems.length;
}
