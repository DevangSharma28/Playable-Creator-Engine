import fs from "node:fs";
import path from "node:path";

export const CONFIG_NAME = "ion.config.json";

/** Every field, with the value used when a project omits it. */
export const DEFAULTS = {
  name: "ion-project",
  version: "0.1.0",
  /** The ION release this project is built against. `ion doctor` compares it to what's installed. */
  ionVersion: "0.1.0",
  /** "playable-ad" | "web-game" | "3d-game" — selects build defaults, not engine features. */
  target: "playable-ad",
  orientation: "portrait",
  resolution: { width: 1080, height: 1920 },
  server: { port: 8000, apiPort: 8001 },
  build: {
    outDir: "dist",
    singleFile: true,
    /** Hard ceiling; `ion build` fails past it. Ad networks enforce their own, usually 5 MB. */
    budgetBytes: 5 * 1024 * 1024,
    halfFloat: true,
    /** Fail the build on an ad-network compatibility finding. */
    failOnCompatWarnings: true,
  },
};

const ORIENTATIONS = ["portrait", "landscape", "both"];
const TARGETS = ["playable-ad", "web-game", "3d-game"];

function merge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object" ? merge(base[k], v) : v;
  }
  return out;
}

/** Reads and validates ion.config.json. Throws with an actionable message rather than returning something half-valid. */
export function loadConfig(projectRoot) {
  const file = path.join(projectRoot, CONFIG_NAME);
  if (!fs.existsSync(file)) {
    throw new Error(`No ${CONFIG_NAME} in ${projectRoot}.\n  Is this an ION project? Create one with: node create-ion-project.mjs`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${CONFIG_NAME} is not valid JSON: ${err.message}`);
  }
  const config = merge(DEFAULTS, raw);
  const problems = [];
  if (!config.name || !/^[a-z0-9][a-z0-9._-]*$/i.test(config.name)) problems.push(`"name" must be a valid package-style name (got ${JSON.stringify(config.name)})`);
  if (!TARGETS.includes(config.target)) problems.push(`"target" must be one of ${TARGETS.join(", ")} (got ${JSON.stringify(config.target)})`);
  if (!ORIENTATIONS.includes(config.orientation)) problems.push(`"orientation" must be one of ${ORIENTATIONS.join(", ")}`);
  if (!Number.isFinite(config.resolution?.width) || !Number.isFinite(config.resolution?.height)) problems.push(`"resolution" needs numeric width and height`);
  if (!Number.isFinite(config.server?.port)) problems.push(`"server.port" must be a number`);
  if (problems.length) throw new Error(`${CONFIG_NAME} has ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  return config;
}

export function findProjectRoot(from = process.cwd()) {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_NAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
