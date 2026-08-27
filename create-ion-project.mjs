#!/usr/bin/env node
/**
 * ION Project Generator.
 *
 * Creates a complete ION game project in an empty folder. One file, no
 * dependencies, no network required.
 *
 *   node create-ion-project.mjs                 # interactive
 *   node create-ion-project.mjs my-game --yes   # defaults, no prompts
 *
 * ## What it does and does not write
 *
 * It writes *your* project: `src/game/`, `ion.config.json`, `package.json`,
 * and the small entry files that tie them together. It does not write the ION
 * engine, editor, or build system — those install from packages into
 * `node_modules`, which is git-ignored.
 *
 * That is deliberate and it is the point. Engine code is not part of your
 * repository, so it never appears in `git status`, cannot be committed, and
 * cannot be pushed. If you edit it in place to try something, `ion doctor`
 * will tell you, and the next `npm install` will put it back.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";

/** Fallback only. When packages are resolved locally the real version is read from them — see ionVersionOf(). */
const ION_VERSION_FALLBACK = "0.0.0";
const MIN_NODE = 20;

// ─────────────────────────────────────────────────────────────── arguments ──

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
/** Flags that consume the next argument — everything else is a bare switch. */
const VALUE_FLAGS = new Set(["name", "template", "ion-packages", "root"]);
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && VALUE_FLAGS.has(argv[i - 1].slice(2)))
);

const say = (m = "") => console.log(m);
/** Whichever of the relative or absolute form is actually shorter — a relative path out of /private/tmp is not more readable than the real one. */
const shortPath = (p) => {
  const rel = path.relative(process.cwd(), p);
  return rel && rel.length < p.length ? rel : p;
};
const die = (m) => {
  console.error(`\n✖ ${m}\n`);
  process.exit(1);
};

// ─────────────────────────────────────────────────────────────── templates ──

const TEMPLATES = {
  "playable-ad": {
    label: "Playable Ad",
    blurb: "Portrait, single-file output, CTA + endcard wiring, 5 MB budget.",
    orientation: "portrait",
    resolution: { width: 1080, height: 1920 },
  },
  "3d-game": {
    label: "3D Game",
    blurb: "Landscape, orbit-friendly camera, no ad-network assumptions.",
    orientation: "landscape",
    resolution: { width: 1920, height: 1080 },
  },
  "web-game": {
    label: "Web Game",
    blurb: "Responsive, both orientations, larger size budget.",
    orientation: "both",
    resolution: { width: 1280, height: 720 },
  },
};

// ────────────────────────────────────────────────────────────── validation ──

function validateName(name) {
  if (!name) return "a project name is required";
  if (name.length > 214) return "name is too long (max 214 characters)";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    return `"${name}" isn't a usable package name — use lowercase letters, digits, dot, dash or underscore, starting with a letter or digit`;
  }
  return null;
}

function validateDestination(dir) {
  if (!fs.existsSync(dir)) return null;
  if (!fs.statSync(dir).isDirectory()) return `${dir} exists and is not a directory`;
  const entries = fs.readdirSync(dir).filter((f) => f !== "create-ion-project.mjs" && !f.startsWith("."));
  if (entries.length === 0) return null;
  if (entries.includes("ion.config.json")) {
    return `${dir} is already an ION project.\n  Generating over it would overwrite src/game. Delete it first, or choose another folder.`;
  }
  return `${dir} is not empty (${entries.slice(0, 4).join(", ")}${entries.length > 4 ? ", …" : ""}).\n  Generate into an empty folder.`;
}

/**
 * Where the four @ion-engine packages should come from.
 *
 * Order matters, and the middle case is the one that stops a very confusing
 * first run. The packages are not on the public registry, so emitting
 * `"@ion-engine/build": "^0.1.0"` into package.json makes `npm install` fail
 * with a bare E404 that says nothing about ION. When this generator is being
 * run out of an ION checkout — which is exactly what happens while the
 * packages are unpublished — the checkout right next to it is the obvious and
 * correct source, so use it and say so.
 *
 * @returns {{ mode: "local"|"registry", dir: string|null, problem: string|null }}
 */
function resolveIonPackages(explicit) {
  const check = (dir, source) => {
    if (!fs.existsSync(path.join(dir, "runtime", "package.json"))) {
      return { mode: "local", dir, problem: `${source} doesn't contain the ION packages (no runtime/package.json in ${dir}).` };
    }
    if (!fs.existsSync(path.join(dir, "runtime", "dist", "index.js"))) {
      return {
        mode: "local",
        dir,
        problem:
          `The ION packages in ${dir} haven't been built.\n` +
          `  Build them first, from the ION checkout:\n` +
          `    node scripts/build-packages.mjs`,
      };
    }
    return { mode: "local", dir, problem: null };
  };

  if (explicit) return check(path.resolve(explicit), "--ion-packages");

  // This file's own neighbours: running `node <ion-checkout>/create-ion-project.mjs`
  // should Just Work without anyone having to know about --ion-packages.
  const adjacent = path.join(path.dirname(fileURLToPath(import.meta.url)), "packages");
  if (fs.existsSync(path.join(adjacent, "runtime", "package.json"))) return check(adjacent, "the ION checkout beside this script");

  return { mode: "registry", dir: null, problem: null };
}

/** The version of the ION packages actually being installed, so ion.config.json pins something real. */
function ionVersionOf(source) {
  if (source.mode !== "local") return ION_VERSION_FALLBACK;
  try {
    return JSON.parse(fs.readFileSync(path.join(source.dir, "runtime", "package.json"), "utf8")).version ?? ION_VERSION_FALLBACK;
  } catch {
    return ION_VERSION_FALLBACK;
  }
}

function preflight() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE) die(`Node ${process.versions.node} is too old — ION needs ${MIN_NODE} or newer.\n  Install a current Node and re-run.`);
}

// ──────────────────────────────────────────────────────── generated files ──

const gameTs = (template) => `import { Game, ION } from "ion";
import { Player } from "./Player";

/**
 * Your game.
 *
 * Two methods and you have a game. Everything underneath — renderer, camera,
 * lighting, physics, particles, UI, input, audio, the editor connection, and
 * every file the ION editors write — is already running before start() is
 * called. You never wire any of it up.
 */
export default class MyGame extends Game {
  player!: Player;
  score = 0;

  /** Build your world. Runs once. */
  start() {
    ION.scene.ground({ color: "green", size: 40 });

    this.player = new Player();
    ION.camera.follow(this.player);

    // Something to collect.
    for (let i = 0; i < 5; i++) {
      ION.scene.box({
        color: "yellow",
        size: 0.6,
        // Kept close: a portrait playable sees roughly ±4 units across at
        // the default camera distance, so a wider spread just puts them
        // off-screen at startup.
        x: ION.random(-3.5, 3.5),
        y: 0.3,
        z: ION.random(-6, 2),
        name: \`Coin\${i}\`,
      });
    }
  }

  /** Runs every frame. dt is seconds since the last one. */
  update(dt: number) {
    // Spin every coin. Entities update themselves — this is for loose props.
    for (let i = 0; i < 5; i++) {
      const coin = ION.scene.find(\`Coin\${i}\`);
      if (coin) coin.rotation.y += dt * 2;
    }
  }
${template === "playable-ad" ? `
  /** Runs once everything the editors authored has loaded. */
  ready() {
    ION.ui.text("score", "0");
    // A playable ad must reach an end. Wire yours, then show the endcard.
    // ION.ui.showEndcard();
  }
` : ""}}
`;

const playerTs = `import { Entity, ION } from "ion";

/**
 * A thing in your world.
 *
 * \`new Player()\` puts it in the scene and starts updating it — there is no
 * register step and nothing to add to a list.
 */
export class Player extends Entity {
  speed = 6;

  /** Runs once, when the entity is created. */
  start() {
    this.shape = ION.scene.box({ color: "orange", size: 1, y: 0.5 });
    this.moveTo(0, 0, 0);
  }

  /** Runs every frame. */
  update(dt: number) {
    // Works with the on-screen joystick and with WASD/arrows, no branching.
    const move = ION.input.axis;
    this.moveBy(move.x * this.speed * dt, 0, move.y * this.speed * dt);
  }
}
`;

const mainTs = `import { IonEngine } from "ion";
import MyGame from "./game/Game";
import manifest from "./game/assets";
import environment from "./game/environment.json";
import colliders from "./game/colliders.json";
import particles from "./game/particles.json";
import scene from "./game/scene.json";
import sceneBindings from "./game/sceneBindings.json";
import mainLayout from "./game/ui/mainLayout.json";
import endcardLayout from "./game/ui/endcardLayout.json";

const canvas = document.getElementById("game") as HTMLCanvasElement;

/**
 * Wiring. You should not need to change this file.
 *
 * It hands ION your game class and the files the ION editors write; ION does
 * the rest. Everything you actually work on lives in src/game/.
 *
 * Wrapped in a function rather than awaited at the top level: the production
 * build emits an ES2015, IIFE-format bundle, which has no way to express a
 * top-level await. The bundler tolerates one with a warning — but that warning
 * is a wall of red-and-yellow that reads exactly like a build failure, on a
 * build that actually succeeded.
 */
async function start() {
  // Development only: installs ION Studio. The engine never imports the
  // editor — this is the one place it is named, and it sits behind a check the
  // production build evaluates to false and removes, which is what keeps
  // editor code out of a shipped bundle entirely rather than merely
  // unreachable inside it.
  if (import.meta.env.DEV) {
    (globalThis as Record<string, unknown>).__ION_DEV__ = true;
    const { installEditor } = await import("@ion-engine/editor");
    installEditor();
  }

  IonEngine.boot(canvas, {
    createGame: (c) =>
      MyGame.create.call(MyGame, c, {
        manifest,
        data: { environment, colliders, particles, scene, sceneBindings, mainLayout, endcardLayout },
      }),
  });
}

void start();

if (import.meta.hot) import.meta.hot.accept();
`;

const assetsTs = `import type { AssetEntry } from "@ion-engine/runtime";

/**
 * Everything this project loads, preloaded in one pass before gameplay.
 *
 * Paths are plain strings, not imports: the production build finds these
 * literals and base64-inlines each file into the single-file output.
 *
 *   export const libGlb = { player: "./assets/models/player.glb" } as const;
 *   const manifest: AssetEntry[] = [{ kind: "glb", path: libGlb.player }];
 */
const manifest: AssetEntry[] = [];
export default manifest;
`;

const indexTemplate = (name) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
  <title>${name}</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #000; }
    #game { display: block; width: 100%; height: 100%; touch-action: none; }
    #custom-ui-layer, #endcard-layer { position: fixed; inset: 0; pointer-events: none; }
    #custom-ui-layer > *, #endcard-layer > * { pointer-events: auto; }
    #endcard-layer { display: none; }
  </style>
</head>
<body>
  <canvas id="game"></canvas>
  <div id="custom-ui-layer"></div>
  <div id="endcard-layer"></div>
  <!-- Relative, not absolute: the production build roots at src/, so "/src/main.ts" would resolve one level too deep. -->
  <script type="module" src="./main.ts"></script>
</body>
</html>
`;

const gitignore = `node_modules/
dist/
.build-cache/
public/assets/
.DS_Store
*.log

# ─────────────────────────────────────────────────────────────────────────────
# The ION Engine.
#
# IONEngine/ is written by \`npm install\` from the @ion-engine/* packages this
# project depends on. It is ours, not yours: it is regenerated on every
# install, so an edit there cannot be committed, cannot be pushed, and does not
# survive. That is what keeps this repository's history a record of *your game*
# — every commit you make is src/game/ and project configuration, never engine
# code.
#
# Update it with:  npm run engine:update
# Check it with:   npm run doctor
# ─────────────────────────────────────────────────────────────────────────────
IONEngine/
`;

const tsconfig = `{
  "compilerOptions": {
    "target": "ES2019",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "resolveJsonModule": true,
    "lib": ["ES2019", "DOM"],
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"],

    // The engine is resolved out of IONEngine/, which is where it actually
    // lives for this project. Only the package roots are mapped, so
    // "@ion-engine/runtime" resolves and a deep path into engine internals
    // does not — the package's own exports map decides what is reachable.
    "paths": {
      // What your game imports from. One name, one place.
      "ion": ["./IONEngine/runtime"],
      "@ion-engine/runtime": ["./IONEngine/runtime"],
      "@ion-engine/editor": ["./IONEngine/editor"]
    }
  },
  // IONEngine/ is deliberately not in this list: it is not your source, it is
  // typechecked by ION before release, and including it would make every one
  // of your builds pay for it.
  "include": ["src"]
}
`;

const readme = (name, template) => `# ${name}

Built on the ION Engine (${TEMPLATES[template].label} template).

\`\`\`bash
npm install
npm run dev       # ION Studio → http://localhost:8000
npm run build     # single-file production output in dist/
npm run preview   # serve the built file
npm run doctor    # check Node, config, packages, engine integrity
\`\`\`

## Layout

\`\`\`
IONEngine/        the engine, editor and build tooling   — ION's, generated, git-ignored
src/game/         your game                              — yours, the only place you normally work
src/main.ts       entry point                            — wired for you
ion.config.json   project + engine configuration         — yours
assets/           source assets                          — yours
\`\`\`

| | |
| --- | --- |
| \`src/game/\` | **Yours.** Gameplay, entities, systems, scenes, UI, and the files the ION editors write. |
| \`ion.config.json\` | **Yours.** Name, target, orientation, resolution, build settings, and the pinned ION version. |
| \`assets/\` | **Yours.** Only what \`src/game/assets.ts\` references is shipped. |
| \`IONEngine/\` | **ION's.** Written by \`npm install\`, git-ignored, regenerated every time. |

Every commit in this repository is your game. \`IONEngine/\` is a build artifact
of \`npm install\`, so an edit there cannot be committed, cannot be pushed, and
does not survive the next install. \`npm run doctor\` says so if it happens.

## Updating the engine

\`\`\`bash
npm run engine:update    # npm resolves new versions, IONEngine/ is rewritten
\`\`\`

\`src/game/\` is untouched. \`ionVersion\` in \`ion.config.json\` records what you
were pinned to; \`npm run doctor\` reports a mismatch.

## Writing gameplay

\`src/game/Game.ts\` extends \`IonGame\`. Everything the engine offers comes from
one import:

\`\`\`ts
import { IonGame, Ion, Entity, UILayout, Cta } from "@ion-engine/runtime";
\`\`\`

Deep imports into engine internals are blocked by the package's \`exports\` map —
they fail to resolve rather than compiling and breaking later.

## Studio

\`npm run dev\`, then use the Engine Room panel on the right:

- **🌐 Environment** — camera, lighting, fog, tone mapping, shadows
- **✏️ UI Editor** — HUD and endcard layout
- **🧭 3D Viewer/Editor** — Hierarchy, Inspector, Control Desk; \`K\` colliders, \`P\` particles
- **🛠 Builder** — build and read the size / compatibility report

Everything Studio saves lands in \`src/game/\` and ships with your build.
`;

// ───────────────────────────────────────────────────────────────────── run ──

async function prompt(config) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    if (!config.name) {
      for (;;) {
        const answer = (await rl.question(`  Project name: (${config.defaultName}) `)).trim() || config.defaultName;
        const problem = validateName(answer);
        if (!problem) { config.name = answer; break; }
        say(`  ✖ ${problem}`);
      }
    }
    if (!config.template) {
      say("\n  Template:");
      const keys = Object.keys(TEMPLATES);
      keys.forEach((k, i) => say(`    ${i + 1}) ${TEMPLATES[k].label.padEnd(12)} ${TEMPLATES[k].blurb}`));
      for (;;) {
        const answer = (await rl.question(`  Choose 1-${keys.length}: (1) `)).trim() || "1";
        const index = Number(answer) - 1;
        if (keys[index]) { config.template = keys[index]; break; }
        say(`  ✖ Enter a number between 1 and ${keys.length}.`);
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  preflight();
  say("\n  ION Project Generator\n");

  const targetDir = path.resolve(positional[0] ?? ".");
  const destProblem = validateDestination(targetDir);
  if (destProblem) die(destProblem);

  const config = {
    name: flag("name", null),
    template: flag("template", null),
    defaultName: path.basename(targetDir).replace(/[^a-z0-9._-]/gi, "-").toLowerCase() || "ion-game",
  };
  if (config.template && !TEMPLATES[config.template]) {
    die(`Unknown template "${config.template}".\n  Available: ${Object.keys(TEMPLATES).join(", ")}`);
  }
  if (has("yes")) {
    config.name ??= config.defaultName;
    config.template ??= "playable-ad";
  } else if (!stdin.isTTY) {
    die("No TTY for prompts.\n  Pass --yes (and optionally --name / --template) for a non-interactive run.");
  } else {
    await prompt(config);
  }

  const nameProblem = validateName(config.name);
  if (nameProblem) die(nameProblem);

  const template = TEMPLATES[config.template];
  // `--ion-packages <dir>` points the dependencies at a local packages/ folder
  // instead of the registry. That is how ION itself is tested before a
  // release, and how you would consume an unpublished build.
  const source = resolveIonPackages(flag("ion-packages", null));
  if (source.problem) die(source.problem);
  const local = source.mode === "local" ? source.dir : null;
  const ionVersion = ionVersionOf(source);
  const dep = (pkg) => (local ? `file:${path.resolve(local, pkg)}` : `^${ionVersion}`);

  const files = {
    "ion.config.json": JSON.stringify({
      name: config.name,
      version: "0.1.0",
      ionVersion,
      target: config.template,
      orientation: template.orientation,
      resolution: template.resolution,
      server: { port: 8000, apiPort: 8001 },
      build: {
        outDir: "dist",
        singleFile: true,
        budgetBytes: config.template === "playable-ad" ? 5 * 1024 * 1024 : 20 * 1024 * 1024,
        halfFloat: true,
        failOnCompatWarnings: config.template === "playable-ad",
      },
    }, null, 2) + "\n",
    "package.json": JSON.stringify({
      name: config.name,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        // Writes IONEngine/ from whatever npm just resolved. Runs on every
        // install and every update, so the folder is never stale and there is
        // no setup step for anyone to miss.
        postinstall: "ion sync",
        dev: "ion dev",
        build: "ion build",
        preview: "ion preview",
        doctor: "ion doctor",
        "engine:update": "npm update @ion-engine/runtime @ion-engine/editor @ion-engine/build @ion-engine/project",
        typecheck: "tsc --noEmit",
      },
      dependencies: { "@ion-engine/runtime": dep("runtime"), three: "^0.185.1" },
      devDependencies: {
        "@ion-engine/editor": dep("editor"),
        "@ion-engine/build": dep("build"),
        "@ion-engine/project": dep("project"),
        "@types/three": "^0.185.1",
        typescript: "^7.0.2",
        vite: "^8.2.1",
      },
    }, null, 2) + "\n",
    "tsconfig.json": tsconfig,
    ".gitignore": gitignore,
    "README.md": readme(config.name, config.template),
    "src/main.ts": mainTs,
    "src/index.template.html": indexTemplate(config.name),
    "src/game/Game.ts": gameTs(config.template),
    "src/game/Player.ts": playerTs,
    "src/game/assets.ts": assetsTs,
    "src/game/environment.json": JSON.stringify({ version: 1 }, null, 2) + "\n",
    "src/game/colliders.json": JSON.stringify({ version: 1, colliders: [] }, null, 2) + "\n",
    "src/game/particles.json": JSON.stringify({ version: 1, systems: [] }, null, 2) + "\n",
    // What the 3D editor changes about the scene graph — transforms,
    // visibility, names, parenting. Empty until something is moved.
    "src/game/scene.json": JSON.stringify({ version: 1, objects: [] }, null, 2) + "\n",
    "src/game/sceneBindings.json": JSON.stringify({ version: 1, bindings: [] }, null, 2) + "\n",
    "src/game/ui/bindings.json": JSON.stringify({ version: 1, bindings: [] }, null, 2) + "\n",
    "src/game/ui/mainLayout.json": JSON.stringify({ version: 1, canvasWidth: template.resolution.width / 2.7 | 0, canvasHeight: template.resolution.height / 2.7 | 0, elements: [] }, null, 2) + "\n",
    "src/game/ui/endcardLayout.json": JSON.stringify({ version: 1, canvasWidth: template.resolution.width / 2.7 | 0, canvasHeight: template.resolution.height / 2.7 | 0, elements: [] }, null, 2) + "\n",
    "src/game/entities/.gitkeep": "",
    "src/game/systems/.gitkeep": "",
    "src/game/scenes/.gitkeep": "",
    "src/game/scripts/.gitkeep": "",
    // Created empty so there is somewhere obvious to put a model or a sound.
    // Without them, the first question after "add it to assets.ts" is "add it
    // where?", and the answer is a directory that does not exist yet.
    "assets/models/.gitkeep": "",
    "assets/sounds/.gitkeep": "",
    "assets/image/.gitkeep": "",
    "assets/README.md": "Source assets live here — `models/*.glb`, `sounds/*.ogg`, `image/*`.\n\nReference them from `src/game/assets.ts`; only what the manifest names is shipped.\n",
  };

  // Written only after every path has been computed, so a failure part-way
  // through validation can't leave a half-made project behind.
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const dest = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, contents);
  }

  const where = targetDir === process.cwd() ? "." : path.relative(process.cwd(), targetDir);
  say(`  ✓ ${config.name} — ${template.label}, ${template.orientation}, ${template.resolution.width}×${template.resolution.height}`);
  say(`    ${Object.keys(files).length} files in ${where}`);
  say(`    ION ${ionVersion}${local ? `  (from ${shortPath(local)})` : "  (from the npm registry)"}`);
  if (!local) {
    say("");
    say("  ⚠ The @ion-engine packages are not on the public npm registry.");
    say("    `npm install` will fail with E404 unless you are authenticated to a");
    say("    registry that hosts them. If you have an ION checkout, point at it:");
    say("      node create-ion-project.mjs --ion-packages /path/to/ion/packages");
  }
  say("");
  say("    src/game/          yours");
  say("    node_modules/      ION engine, editor, build — git-ignored, not yours to edit");
  say("");
  say("  Next:\n");
  // Quoted when it needs to be: the instruction is meant to be copied into a
  // shell, and `cd My Game` is not a command that works.
  if (where !== ".") say(`    cd ${/[\s"'$`\\]/.test(where) ? JSON.stringify(where) : where}`);
  say("    npm install");
  say("    npm run dev\n");
}

main().catch((err) => die(err.stack || String(err)));
