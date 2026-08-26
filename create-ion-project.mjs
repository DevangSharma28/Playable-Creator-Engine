#!/usr/bin/env node
/**
 * ION Engine project scaffolder — one file, zero dependencies.
 *
 * Drop this into an empty folder and run it. It lays down the whole engine
 * plus a runnable starter game, after which `npm install && npm run dev` is
 * all that's left.
 *
 *   node create-ion-project.mjs                      # scaffold into the cwd
 *   node create-ion-project.mjs my-playable          # ...or into a new folder
 *   node create-ion-project.mjs --from ../ion-repo   # from a local checkout
 *   node create-ion-project.mjs --name cool-ad       # set the package name
 *   node create-ion-project.mjs --ref some-branch    # pull a different branch
 *
 * Why a scaffolder and not `npm install ion-engine`: the engine is not a
 * published package, and it can't currently become one unchanged. `main.ts`
 * imports it by relative path, the production build inlines its source into a
 * single HTML file, and the Engine Room dev panel (index.html) and the visual
 * UI editor (tools/ui-editor.html) are project files rather than library
 * exports. Copying the tree in is what actually works today — and it has a
 * real upside: the engine is right there in `src/engine/` where you can read
 * and change it, which is the normal way people work on a playable.
 *
 * What you get:
 *   src/engine/        the engine, verbatim — yours to edit
 *   src/game/          a fresh, runnable starter you replace
 *   index.html         the Engine Room dev panel
 *   tools/             the visual UI editor
 *   scripts/           dev server, build API, asset compression
 *   build.sh           the single-file production pipeline
 *   .github/workflows  CI, if the source repo has it
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const DEFAULT_REPO = "DevangSharma28/Playable-Creator-Engine";

// ---------------------------------------------------------------- args ----

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));

const targetDir = path.resolve(positional[0] ?? ".");
const from = flag("from", null);
const repo = flag("repo", DEFAULT_REPO);
const ref = flag("ref", "main");
const projectName = flag("name", path.basename(targetDir).replace(/[^a-z0-9._-]/gi, "-").toLowerCase() || "ion-playable");

const say = (msg) => console.log(msg);
const die = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

// ------------------------------------------------------- source of truth ---

/** Everything copied verbatim out of the engine repo. Directories are recursive. */
const COPY = [
  "src/engine",
  "src/main.ts",
  "src/index.template.html",
  "index.html",
  "tools/ui-editor.html",
  "scripts/dev.js",
  "scripts/dev-build-api.js",
  "scripts/compress-assets.mjs",
  "scripts/sync-assets.js",
  "scripts/check-build-report.mjs",
  "build.sh",
  "vite.config.mts",
  "vite.config.prod.mts",
  "tsconfig.json",
  ".gitignore",
  ".github/workflows/ci.yml",
];

/** Present in the engine repo but deliberately NOT copied — they belong to that project, not yours. */
const SKIP_NOTE = ["src/game", "assets", "public", "tests", "ENGINE.md", "README.md", "HOW_TO_USE.md"];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dest, entry));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    if (dest.endsWith(".sh")) fs.chmodSync(dest, 0o755);
  }
}

/** Downloads the repo tarball and unpacks it into a temp dir, returning that path. */
async function fetchSource() {
  const url = `https://codeload.github.com/${repo}/tar.gz/refs/heads/${ref}`;
  say(`  Downloading ${repo}@${ref}…`);
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    die(`Could not reach GitHub (${err.message}).\n  If you already have the engine locally, use:\n    node create-ion-project.mjs --from /path/to/Playable-Creator-Engine`);
  }
  if (!res.ok) die(`GitHub returned ${res.status} for ${url}\n  Check --repo and --ref, or use --from with a local checkout.`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ion-"));
  const tarball = path.join(tmp, "src.tar.gz");
  fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  try {
    // `tar` ships with macOS, Linux, and Windows 10+. Shelling out beats
    // hand-rolling a gzip+tar reader for the one place this is needed.
    execFileSync("tar", ["-xzf", tarball, "-C", tmp]);
  } catch {
    die("`tar` is not available on PATH — unpack the repo yourself and re-run with --from <path>.");
  }
  const unpacked = fs.readdirSync(tmp).map((d) => path.join(tmp, d)).find((d) => fs.statSync(d).isDirectory());
  if (!unpacked) die("Downloaded archive looked empty.");
  return unpacked;
}

// ------------------------------------------------------ generated files ----

const STARTER_GAME = `import * as THREE from "three";
import { CameraHandler } from "../engine/core/CameraHandler";
import { SceneEnvironment, loadSceneEnv } from "../engine/scene";
import { AssetLoader } from "../engine/AssetLoader";
import { UILayout } from "../engine/ui/UILayout";
import type { UILayoutData } from "../engine/ui/UILayoutTypes";
import { Ion } from "../engine/Ion";
import { Cta } from "../engine/Cta";
import { setCrashRecoveryUrl } from "../engine/core/CrashOverlay";
import { loadColliders } from "../engine/collision";
import type { CollidersFileData } from "../engine/collision";
import { loadParticles } from "../engine/particles";
import type { ParticlesFileData } from "../engine/particles";
import { applySceneBindings, type SceneBindingsData } from "../engine/SceneBindings";
import { manifest } from "./assets";
import environmentRaw from "./environment.json";
import collidersRaw from "./colliders.json";
import particlesRaw from "./particles.json";
import sceneBindingsRaw from "./sceneBindings.json";
import mainLayoutRaw from "./ui/mainLayout.json";

/** Swap this for the real store listing before you ship. Every CTA routes through Cta.open(). */
const STORE_URL = "https://example.com";
setCrashRecoveryUrl(STORE_URL);

const environmentData = loadSceneEnv(environmentRaw as unknown);
const mainLayoutData = mainLayoutRaw as UILayoutData;

/**
 * Your playable.
 *
 * IonEngine requires exactly four things of this class: a static create(),
 * update(), render(), and dispose(). Everything the Engine Room dev panel can
 * additionally ask for is optional — see GameDevFacade in
 * src/engine/IonEngine.ts — so add those only if you want that button to work.
 */
export class Game {
  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly rig: CameraHandler;
  private readonly sceneEnv: SceneEnvironment;
  private readonly assetLoader: AssetLoader;
  private readonly mainUI: UILayout;
  private readonly cube: THREE.Mesh;

  private constructor(canvas: HTMLCanvasElement, assetLoader: AssetLoader) {
    this.assetLoader = assetLoader;

    // The rig owns both cameras and every projection setting. Build it before
    // the environment, which drives it.
    this.rig = new CameraHandler(environmentData.camera);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Lights, fog, background, tone mapping and shadows all come from
    // environment.json, authored in the editor's Environment dock. Nothing
    // else in your game should add scene lighting.
    this.sceneEnv = new SceneEnvironment(
      {
        scene: this.scene,
        renderer: this.renderer,
        rig: this.rig,
        resolveTexture: (p) => {
          try {
            return this.assetLoader.getTexture(p);
          } catch {
            return undefined;
          }
        },
      },
      environmentData
    );
    this.sceneEnv.apply();
    this.rig.handleResize(window.innerWidth, window.innerHeight);

    // ---- your scene starts here -------------------------------------------
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0x4c9a52, roughness: 0.95 })
    );
    ground.name = "Ground";
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.cube = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.5, 1.5),
      new THREE.MeshStandardMaterial({ color: 0xe8961e, roughness: 0.4, metalness: 0.1 })
    );
    this.cube.name = "Cube";
    this.cube.position.set(0, 0.75, 0);
    this.cube.castShadow = true;
    this.scene.add(this.cube);
    // -----------------------------------------------------------------------

    // Registries join the scene, then the editor-authored data loads into
    // them. Order matters: colliders and particles record attachments as
    // scene paths, so anything they attach to must already exist above.
    Ion.colliders.attachToScene(this.scene);
    loadColliders(Ion.colliders, collidersRaw as CollidersFileData, this.scene);
    Ion.particles.attachToScene(this.scene);
    loadParticles(Ion.particles, particlesRaw as ParticlesFileData, this.scene);

    // "⊙ Pick" assignments from the editor's Control Desk. Register a class
    // here and its scene fields persist across reloads and into production.
    applySceneBindings(this, "Game", sceneBindingsRaw as SceneBindingsData, this.scene);

    const mainLayer = document.getElementById("custom-ui-layer") as HTMLElement;
    this.mainUI = new UILayout(mainLayer, mainLayoutData);
    // Every CTA goes through Cta.open() — never window.open() directly.
    this.mainUI.onAction((event) => {
      if (event === "cta") Cta.open(STORE_URL);
    });

    window.addEventListener("resize", this.onWindowResize);
  }

  private readonly onWindowResize = (): void => {
    this.rig.handleResize(window.innerWidth, window.innerHeight);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.mainUI.updateScale(window.innerWidth, window.innerHeight);
  };

  static async create(canvas: HTMLCanvasElement): Promise<Game> {
    const loader = new AssetLoader();
    await loader.preload(manifest);
    return new Game(canvas, loader);
  }

  /** One gameplay tick. dt is seconds; elapsed is game time (pauses with the editor). */
  update(dt: number, _elapsed: number): void {
    this.cube.rotation.y += dt * 1.2;
    this.rig.update(this.cube.position, dt);
  }

  render(): void {
    Ion.particles.setCamera(this.rig.camera);
    Ion.particles.render();
    this.renderer.render(this.scene, this.rig.camera);
  }

  dispose(): void {
    window.removeEventListener("resize", this.onWindowResize);
    this.mainUI.dispose();
    this.sceneEnv.dispose();
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------------
  // Optional dev-panel members. None of these are required — see
  // GameDevFacade in src/engine/IonEngine.ts. Each one you implement makes
  // the matching Engine Room control start working; leave it out and that
  // control simply does nothing. These two are the cheapest and most useful.
  // ---------------------------------------------------------------------

  /** Feeds the Engine Room's FPS / draw calls / triangles readout. */
  get rendererStats(): { drawCalls: number; triangles: number } {
    return { drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
  }

  /** Lets the Device Preview bar letterbox the game to a fixed aspect ratio. */
  resizeTo(width: number, height: number): void {
    this.rig.handleResize(width, height);
    this.renderer.setSize(width, height);
    this.mainUI.updateScale(width, height);
  }
}
`;

const STARTER_ASSETS = `import type { AssetEntry } from "../engine/AssetLoader";

/**
 * Everything this playable loads, preloaded in one pass before gameplay.
 * Nothing loads lazily — a playable ad can't afford a stall mid-interaction.
 *
 * Paths are relative strings, not imports: build.sh finds these literals and
 * base64-inlines each file into the single-file output.
 *
 *   export const libGlb = { player: "./assets/models/player.glb" } as const;
 *   export const manifest: AssetEntry[] = [{ kind: "glb", path: libGlb.player }];
 */
export const manifest: AssetEntry[] = [];
`;

const GENERATED = {
  "src/game/Game.ts": STARTER_GAME,
  "src/game/assets.ts": STARTER_ASSETS,
  "src/game/environment.json": JSON.stringify({ version: 1 }, null, 2) + "\n",
  "src/game/colliders.json": JSON.stringify({ version: 1, colliders: [] }, null, 2) + "\n",
  "src/game/particles.json": JSON.stringify({ version: 1, systems: [] }, null, 2) + "\n",
  "src/game/sceneBindings.json": JSON.stringify({ version: 1, bindings: [] }, null, 2) + "\n",
  "src/game/ui/bindings.json": JSON.stringify({ version: 1, bindings: [] }, null, 2) + "\n",
  "src/game/ui/mainLayout.json": JSON.stringify({ version: 1, canvasWidth: 400, canvasHeight: 711, elements: [] }, null, 2) + "\n",
  "src/game/ui/endcardLayout.json": JSON.stringify({ version: 1, canvasWidth: 400, canvasHeight: 711, elements: [] }, null, 2) + "\n",
  "assets/README.md": "Put source assets here — `models/*.glb`, `sounds/*.ogg`, `image/*`.\n\nReference them from `src/game/assets.ts` as `\"./assets/...\"` string literals.\nOnly what the manifest references is compressed and inlined by `npm run build`.\n",
};

function packageJson() {
  return JSON.stringify(
    {
      name: projectName,
      version: "0.1.0",
      private: true,
      description: "A playable ad built on the ION Engine.",
      scripts: {
        predev: "node scripts/sync-assets.js",
        dev: "node scripts/dev.js",
        build: "bash build.sh",
        "check:build": "node scripts/check-build-report.mjs",
        typecheck: "tsc --noEmit",
      },
      devDependencies: {
        "@gltf-transform/core": "^4.4.2",
        "@gltf-transform/extensions": "^4.4.2",
        "@gltf-transform/functions": "^4.4.2",
        "@types/three": "^0.185.1",
        esbuild: "^0.28.2",
        meshoptimizer: "^1.2.0",
        sharp: "^0.35.3",
        typescript: "^7.0.2",
        vite: "^8.2.1",
        "vite-plugin-singlefile": "^2.3.3",
      },
      dependencies: { three: "^0.185.1" },
    },
    null,
    2
  ) + "\n";
}

function readme() {
  return `# ${projectName}

A playable ad built on the ION Engine.

\`\`\`bash
npm install
npm run dev      # http://localhost:8000 — game + Engine Room dev panel
npm run build    # dist/index.html, one self-contained file
\`\`\`

## Layout

| Path | What it is |
| --- | --- |
| \`src/game/\` | **Yours.** Gameplay, entities, UI classes, and the authored JSON. |
| \`src/engine/\` | The engine. Reusable; edit only when you mean to change the engine. |
| \`index.html\` | The Engine Room dev panel — dev only, never shipped. |
| \`tools/ui-editor.html\` | The visual UI editor. |
| \`assets/\` | Source assets. Only what \`src/game/assets.ts\` references gets shipped. |

## First steps

1. \`npm run dev\`, then open the Engine Room panel (right-hand side).
2. **🌐 Environment** dock → set lighting, camera framing, fog, tone mapping.
   Turn *Environment* to "Generated room" if anything in your scene is metallic.
3. **✏️ UI Editor** → design your HUD and endcard.
4. **🧭 3D Viewer/Editor** → place colliders (🧊) and particle effects (✨).
5. Edit \`src/game/Game.ts\` for gameplay. Point \`STORE_URL\` at the real listing.
6. **Wire an end state** — show your endcard and fire the CTA. A playable with
   no reachable ending fails ad-network review regardless of anything else.
7. \`npm run build\`, then open **📊 Build Report** and confirm there are no
   compatibility warnings. \`npm run build\` fails on its own if there are.

## The Game contract

\`IonEngine\` requires four things: \`static create(canvas)\`, \`update(dt, elapsed)\`,
\`render()\`, and \`dispose()\`. Everything the dev panel can additionally ask for is
optional — see \`GameDevFacade\` in \`src/engine/IonEngine.ts\`. Implement a member
and the matching Engine Room control starts working; leave it out and that
control does nothing.
`;
}

// ------------------------------------------------------------------ run ----

async function main() {
  say("\nION Engine — project scaffolder\n");

  if (fs.existsSync(targetDir)) {
    const existing = fs.readdirSync(targetDir).filter((f) => f !== "create-ion-project.mjs" && !f.startsWith("."));
    if (existing.length) {
      die(`${targetDir} is not empty (found ${existing.slice(0, 4).join(", ")}${existing.length > 4 ? ", …" : ""}).\n  Scaffold into an empty folder, or pass a new directory name.`);
    }
  }
  fs.mkdirSync(targetDir, { recursive: true });

  let source, cleanup;
  if (from) {
    source = path.resolve(from);
    if (!fs.existsSync(path.join(source, "src", "engine"))) {
      die(`--from ${source} doesn't look like an ION Engine checkout (no src/engine).`);
    }
    say(`  Source: ${source}`);
  } else {
    source = await fetchSource();
    cleanup = path.dirname(source);
  }

  say("  Copying engine…");
  let copied = 0;
  for (const rel of COPY) {
    const src = path.join(source, rel);
    if (!fs.existsSync(src)) {
      if (rel.startsWith(".github")) continue; // optional
      say(`    ! missing in source, skipped: ${rel}`);
      continue;
    }
    copyRecursive(src, path.join(targetDir, rel));
    copied++;
  }

  say("  Writing starter game…");
  for (const [rel, contents] of Object.entries(GENERATED)) {
    const dest = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, contents);
  }
  fs.writeFileSync(path.join(targetDir, "package.json"), packageJson());
  fs.writeFileSync(path.join(targetDir, "README.md"), readme());

  if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });

  const where = targetDir === process.cwd() ? "." : path.relative(process.cwd(), targetDir);
  say(`\n✓ Scaffolded ${projectName} into ${where} (${copied} engine paths, ${Object.keys(GENERATED).length + 2} generated files)`);
  say(`  Not copied from the source project: ${SKIP_NOTE.join(", ")} — those belong to it, not to you.`);
  say("\nNext:\n");
  if (where !== ".") say(`  cd ${where}`);
  say("  npm install");
  say("  npm run dev        → http://localhost:8000\n");
}

main().catch((err) => die(err.stack || String(err)));
