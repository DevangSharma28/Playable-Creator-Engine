import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { enginePackageDir, enginePackageEntry } from "./resolve.mjs";

/**
 * Everything a build needs to know about a project, as the script + env to run.
 *
 * Shared by `ion build` and by the Studio's Builder button (which reaches it
 * through the dev API). They used to construct the invocation separately, and
 * the Builder's copy still shelled `bash build.sh` from the project root —
 * which does not exist in a generated project, because the pipeline lives in
 * the ION package. One producer means the two cannot disagree about how a
 * build is run.
 */
export function buildInvocation(projectRoot, opts = {}) {
  const config = loadConfig(projectRoot);
  const buildPkg = enginePackageDir(projectRoot, "@ion-engine/build");
  if (!buildPkg) throw new Error("The ION build system isn't available.\n  Run `npm install` — @ion-engine/build is a devDependency of this project.");
  const buildLib = path.join(buildPkg, "lib");
  const script = path.join(buildLib, "build.sh");
  if (!fs.existsSync(script)) throw new Error(`@ion-engine/build is installed but incomplete (${script} missing). Reinstall it.`);
  return {
    script,
    env: {
      ION_PROJECT_ROOT: projectRoot,
      ION_BUILD_LIB: buildLib,
      ION_VITE_CONFIG: path.join(buildLib, "vite.config.prod.mts"),
      ION_RUNTIME_ENTRY: enginePackageEntry(projectRoot, "@ion-engine/runtime") ?? "",
      ION_BUDGET_BYTES: String(config.build.budgetBytes),
      HALF_FLOAT: (opts.halfFloat ?? config.build.halfFloat) ? "1" : "0",
      ALLOW_COMPAT_WARNINGS: config.build.failOnCompatWarnings === false ? "1" : (process.env.ALLOW_COMPAT_WARNINGS ?? ""),
    },
  };
}

export function build(projectRoot, opts = {}) {
  const { script, env } = buildInvocation(projectRoot, opts);
  // Everything the pipeline needs to know about *this* project travels as
  // environment, so build.sh itself stays the same file ION develops against.
  const result = spawnSync("bash", [script], { cwd: projectRoot, stdio: "inherit", env: { ...process.env, ...env } });
  return result.status ?? 1;
}
