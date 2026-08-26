#!/usr/bin/env node
import process from "node:process";
import { findProjectRoot } from "../lib/config.mjs";

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : undefined;
};

const USAGE = `
  ion — the ION Engine project command

    ion dev        Start ION Studio and the dev server
    ion build      Produce the production build
    ion preview    Serve the last production build
    ion doctor     Check Node, config, packages and engine integrity

  Options
    --port <n>     Dev server port     (default: ion.config.json server.port)
    --api-port <n> Dev API port        (default: ion.config.json server.apiPort)
    --root <dir>   Project directory   (default: nearest ion.config.json)
`;

const root = flag("root") ? require("node:path").resolve(flag("root")) : findProjectRoot();
if (!root && command !== "help" && command !== undefined) {
  console.error("\n✖ No ion.config.json found here or in any parent directory.\n  Is this an ION project?\n");
  process.exit(1);
}

try {
  switch (command) {
    case "dev": {
      const { dev } = await import("../lib/dev.mjs");
      await dev(root, { port: Number(flag("port")) || undefined, apiPort: Number(flag("api-port")) || undefined });
      break;
    }
    case "build": {
      const { build } = await import("../lib/build.mjs");
      process.exit(build(root));
      break;
    }
    case "preview": {
      const { preview } = await import("../lib/preview.mjs");
      await preview(root, { port: Number(flag("port")) || undefined });
      break;
    }
    case "doctor": {
      const { doctor } = await import("../lib/doctor.mjs");
      process.exit(doctor(root) ? 1 : 0);
    }
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
}
