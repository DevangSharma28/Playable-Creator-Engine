import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { enginePackageDir } from "./sync.mjs";
import { createRequire as _cr } from "node:module";

/** Absolute path to the runtime's public entry, honouring its exports map. */
function runtimeEntry(projectRoot) {
  const dir = enginePackageDir(projectRoot, "@ion-engine/runtime");
  if (!dir) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const main = manifest.exports?.["."]?.default ?? manifest.main;
    return typeof main === "string" ? path.join(dir, main) : null;
  } catch {
    return null;
  }
}

export function build(projectRoot, opts = {}) {
  const config = loadConfig(projectRoot);
  const require = createRequire(path.join(projectRoot, "package.json"));
  const buildPkg = enginePackageDir(projectRoot, "@ion-engine/build", "executed");
  if (!buildPkg) throw new Error("The ION build system isn't available.\n  Run `npm install` — that installs it and writes IONEngine/.");
  const buildLib = path.join(buildPkg, "lib");
  const script = path.join(buildLib, "build.sh");
  if (!fs.existsSync(script)) throw new Error(`@ion-engine/build is installed but incomplete (${script} missing). Reinstall it.`);

  // Everything the pipeline needs to know about *this* project travels as
  // environment, so build.sh itself stays the same file ION develops against.
  const result = spawnSync("bash", [script], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ION_PROJECT_ROOT: projectRoot,
      ION_BUILD_LIB: buildLib,
      ION_VITE_CONFIG: path.join(buildLib, "vite.config.prod.mts"),
      // So `import … from "ion"` resolves in the production build too.
      ION_RUNTIME_ENTRY: runtimeEntry(projectRoot) ?? "",
      HALF_FLOAT: (opts.halfFloat ?? config.build.halfFloat) ? "1" : "0",
      ION_BUDGET_BYTES: String(config.build.budgetBytes),
      ALLOW_COMPAT_WARNINGS: config.build.failOnCompatWarnings === false ? "1" : (process.env.ALLOW_COMPAT_WARNINGS ?? ""),
    },
  });
  return result.status ?? 1;
}
