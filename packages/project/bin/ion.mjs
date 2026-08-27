#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import fs from "node:fs";
import { findProjectRoot, CONFIG_NAME } from "../lib/config.mjs";

const [command, ...rest] = process.argv.slice(2);

/** `--name value`. Returns undefined when the flag is absent or has no value after it. */
function flag(name) {
  const index = rest.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = rest[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`--${name} needs a value, e.g. --${name} ${name.includes("port") ? "8000" : "./my-project"}`);
  }
  return value;
}

/** A port flag. Distinguished from `flag` so `--port 0` and `--port abc` are not both silently "unset". */
function portFlag(name) {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) fail(`--${name} must be a port number between 0 and 65535 (got ${JSON.stringify(raw)})`);
  return value;
}

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const USAGE = `
  ion — the ION Engine project command

    ion dev        Start ION Studio and the dev server
    ion build      Produce the production build
    ion preview    Serve the last production build
    ion sync       Refresh IONEngine/ from the installed packages
    ion doctor     Check Node, config, packages and engine integrity

  Options
    --port <n>     Dev server port     (default: ion.config.json server.port)
    --api-port <n> Dev API port        (default: ion.config.json server.apiPort)
    --root <dir>   Project directory   (default: nearest ion.config.json)
`;

if (command === undefined || command === "help" || command === "--help" || command === "-h") {
  console.log(USAGE);
  process.exit(0);
}

const KNOWN = ["dev", "build", "preview", "sync", "doctor"];
if (!KNOWN.includes(command)) {
  console.error(`\n✖ Unknown command "${command}".\n${USAGE}`);
  process.exit(1);
}

// `require` does not exist in an ES module, so the previous form of this line
// crashed with a ReferenceError before any command could run — every use of
// `--root` was broken.
const explicitRoot = flag("root");
let root;
if (explicitRoot) {
  root = path.resolve(explicitRoot);
  if (!fs.existsSync(root)) fail(`--root ${explicitRoot} does not exist.`);
  if (!fs.existsSync(path.join(root, CONFIG_NAME))) fail(`${root} has no ${CONFIG_NAME}.\n  Is this an ION project? Create one with: node create-ion-project.mjs`);
} else {
  root = findProjectRoot();
  if (!root) fail(`No ${CONFIG_NAME} found here or in any parent directory.\n  Is this an ION project? Create one with: node create-ion-project.mjs`);
}

try {
  switch (command) {
    case "dev": {
      const { dev } = await import("../lib/dev.mjs");
      await dev(root, { port: portFlag("port"), apiPort: portFlag("api-port") });
      break;
    }
    case "build": {
      const { build } = await import("../lib/build.mjs");
      process.exit(build(root));
      break;
    }
    case "preview": {
      const { preview } = await import("../lib/preview.mjs");
      await preview(root, { port: portFlag("port") });
      break;
    }
    case "sync": {
      const { sync } = await import("../lib/sync.mjs");
      process.exit(sync(root).missing.length ? 1 : 0);
      break;
    }
    case "doctor": {
      const { doctor } = await import("../lib/doctor.mjs");
      process.exit(doctor(root) ? 1 : 0);
      break;
    }
  }
} catch (err) {
  // The message is the product here: every throw in lib/ is written to be read
  // by whoever ran the command. The stack is kept behind a flag rather than
  // printed, because a resolution failure's stack says nothing useful.
  console.error(`\n✖ ${err.message}\n`);
  if (process.env.ION_DEBUG) console.error(err.stack);
  process.exit(1);
}
