/**
 * Port allocation, and therefore whether a second ION project can start.
 *
 * Before this existed, it could not. Every generated project ships the same
 * `server.port` in its config — the generator has no way to know what else is
 * running — and both halves of the dev environment treated that number as a
 * requirement. Vite exited with `Port 8000 is already in use`, and the dev
 * API, a separate process with no `error` handler on its listener, died first
 * with a raw unhandled `EADDRINUSE` stack trace that never mentioned ION.
 *
 * Running several projects at once is the normal case for this tool, so the
 * configured port is a preference and the first free one is used instead.
 */

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { findFreePort, isPortFree, allocateDevPorts } from "../packages/project/lib/ports.mjs";

/** Holds a port for the duration of a test, the way another project would. */
function occupy(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () =>
      resolve({ port, release: () => new Promise((done) => server.close(done)) })
    );
  });
}

/**
 * A port nothing is using, to anchor tests that need a known-free start.
 *
 * Drawn from a quiet static range rather than by binding port 0 and releasing
 * it: an OS-assigned port comes from the ephemeral range, which the kernel
 * recycles aggressively, so the number was routinely taken again before the
 * test could use it. Probing a static range and keeping the first port that is
 * genuinely free removes that race.
 */
async function anyFreePort() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const candidate = 21000 + Math.floor(Math.random() * 15000);
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error("could not find a free port to test with");
}

test("isPortFree", async (t) => {
  await t.test("reports a bound port as taken and a free one as free", async () => {
    const free = await anyFreePort();
    assert.equal(await isPortFree(free), true);
    const held = await occupy(free);
    try {
      assert.equal(await isPortFree(free), false);
    } finally {
      await held.release();
    }
    assert.equal(await isPortFree(free), true, "the port did not come back after release");
  });
});

test("findFreePort", async (t) => {
  await t.test("returns the preferred port when it is free", async () => {
    const free = await anyFreePort();
    assert.equal(await findFreePort(free), free);
  });

  await t.test("steps past an occupied port", async () => {
    const base = await anyFreePort();
    const held = await occupy(base);
    try {
      const chosen = await findFreePort(base);
      assert.notEqual(chosen, base);
      assert.ok(chosen > base, `expected a port above ${base}, got ${chosen}`);
      assert.equal(await isPortFree(chosen), true);
    } finally {
      await held.release();
    }
  });

  await t.test("steps past a run of occupied ports", async () => {
    // Three ION projects already running is an ordinary Tuesday.
    const base = await anyFreePort();
    const held = [];
    try {
      for (let offset = 0; offset < 3; offset++) {
        try { held.push(await occupy(base + offset)); } catch { /* someone else has it; the test still holds */ }
      }
      const chosen = await findFreePort(base);
      assert.ok(chosen >= base + held.length, `expected to skip ${held.length} held port(s), got ${chosen}`);
      assert.equal(await isPortFree(chosen), true);
    } finally {
      for (const h of held) await h.release();
    }
  });

  await t.test("honours `skip` for ports claimed but not yet bound", async () => {
    // The dev server picks its port and the API's back to back. Without this,
    // one free port would be handed to both.
    const free = await anyFreePort();
    const chosen = await findFreePort(free, { skip: [free] });
    assert.notEqual(chosen, free);
  });

  await t.test("an unusable preference still yields a usable port", async () => {
    for (const nonsense of [0, -1, 70000, NaN, undefined]) {
      const chosen = await findFreePort(nonsense);
      assert.ok(Number.isInteger(chosen) && chosen > 0 && chosen < 65536, `${nonsense} produced ${chosen}`);
    }
  });

  await t.test("gives up with an actionable message rather than scanning forever", async () => {
    const base = await anyFreePort();
    const held = await occupy(base);
    try {
      // max:1 means "only consider `base`", which is held — so the scan has
      // nowhere to go and must say so usefully.
      await assert.rejects(() => findFreePort(base, { max: 1 }), /No free port found[\s\S]*--port/);
    } finally {
      await held.release();
    }
  });
});

test("allocateDevPorts", async (t) => {
  await t.test("hands back two distinct, free ports", async () => {
    const base = await anyFreePort();
    const { port, apiPort } = await allocateDevPorts({ port: base });
    assert.notEqual(port, apiPort, "the dev server and the API were given the same port");
    assert.equal(await isPortFree(port), true);
    assert.equal(await isPortFree(apiPort), true);
  });

  await t.test("reports which port was wanted when it had to move", async () => {
    const base = await anyFreePort();
    const held = await occupy(base);
    try {
      const { port, movedFrom } = await allocateDevPorts({ port: base });
      assert.equal(movedFrom, base, "the move was not reported");
      assert.notEqual(port, base);
    } finally {
      await held.release();
    }
  });

  await t.test("reports no move when the preferred port was available", async () => {
    const base = await anyFreePort();
    const { port, movedFrom } = await allocateDevPorts({ port: base });
    assert.equal(movedFrom, null);
    assert.equal(port, base);
  });

  await t.test("three projects in a row never collide", async () => {
    // The scenario the whole module exists for: A, B and C started one after
    // another, each holding its pair while the next allocates.
    const base = await anyFreePort();
    const held = [];
    const allocated = [];
    try {
      for (let i = 0; i < 3; i++) {
        const pair = await allocateDevPorts({ port: base });
        allocated.push(pair);
        held.push(await occupy(pair.port), await occupy(pair.apiPort));
      }
      const everyPort = allocated.flatMap((pair) => [pair.port, pair.apiPort]);
      assert.equal(new Set(everyPort).size, everyPort.length, `ports collided: ${everyPort.join(", ")}`);
    } finally {
      for (const h of held) await h.release();
    }
  });
});
