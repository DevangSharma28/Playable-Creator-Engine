/**
 * `@ion-engine/project` — the programmatic side of the `ion` command.
 *
 * The command itself (bin/ion.mjs) is how a project uses this package; this
 * entry exists so tooling that wants to drive the same operations — a CI
 * script, an editor integration, ION's own test suite — can do so without
 * shelling out and parsing output.
 *
 * The package's `exports` map already pointed here. It just had no file behind
 * it, so `import "@ion-engine/project"` failed with ERR_MODULE_NOT_FOUND.
 */

export { dev } from "./dev.mjs";
export { build, buildInvocation } from "./build.mjs";
export { preview } from "./preview.mjs";
export { doctor } from "./doctor.mjs";
export { loadConfig, findProjectRoot, CONFIG_NAME, DEFAULTS } from "./config.mjs";
export { enginePackageDir, enginePackageEntry, enginePackageVersion, ION_PACKAGES } from "./resolve.mjs";
export { findFreePort, isPortFree, allocateDevPorts } from "./ports.mjs";
export { verifyInstall } from "./integrity.mjs";
