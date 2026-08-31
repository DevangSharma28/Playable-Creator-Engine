import net from "node:net";

/**
 * Port allocation for ION projects.
 *
 * ION is a tool people run several copies of at once — one window per playable
 * they are working on. Every generated project starts life with the same
 * `server.port` in its config, because the generator has no way to know what
 * else is running, so "the configured port is free" is the uncommon case, not
 * the common one.
 *
 * Before this existed, the second project simply did not start. Vite reported
 * `Port 8000 is already in use` and exited, and the dev API — a separate
 * process with no error handling on its listener — died first with a raw
 * `Error: listen EADDRINUSE` stack trace and no indication that ION was
 * involved or that another project was the cause.
 *
 * So a configured port is treated as a *preference*, not a requirement: if it
 * is taken, the next free one is used and the choice is printed. Nothing is
 * written back to `ion.config.json` — which project got which port is a fact
 * about this machine right now, not about the project, and quietly rewriting a
 * tracked config file on every `npm run dev` would put port churn in the
 * customer's git history.
 */

/** How far to scan before giving up. Enough for far more ION projects than anyone runs at once, small enough to fail fast if something is wrong. */
const MAX_SCAN = 200;

/**
 * Whether a TCP port can be bound on `host` right now.
 *
 * Binds and immediately closes, rather than trying to connect: a port with no
 * listener refuses a connection, but so does one held by a process that is not
 * accepting yet, and a port bound by another user's process may accept a
 * connection while still being unavailable to us. Binding asks the only
 * question that matters — can *this* process listen here.
 */
export function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    // exclusive so the check cannot succeed against a port another process in
    // the same cluster already holds with SO_REUSEADDR.
    server.listen({ port, host, exclusive: true });
  });
}

/**
 * The first free port at or after `preferred`.
 *
 * @param {number} preferred
 * @param {{ host?: string, max?: number, skip?: Iterable<number> }} [options]
 *   `skip` is for ports this process has already claimed but not yet bound —
 *   the dev server picks its own port and the API's back to back, and without
 *   it a single free port would be handed to both.
 * @returns {Promise<number>}
 */
export async function findFreePort(preferred, options = {}) {
  const { host = "127.0.0.1", max = MAX_SCAN } = options;
  const skip = new Set(options.skip ?? []);
  const start = Number.isInteger(preferred) && preferred > 0 && preferred < 65536 ? preferred : 8000;

  for (let offset = 0; offset < max; offset++) {
    const port = start + offset;
    if (port > 65535) break;
    if (skip.has(port)) continue;
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(
    `No free port found between ${start} and ${Math.min(start + max - 1, 65535)}.\n` +
      "  Something is holding an unusual number of ports, or the range is blocked.\n" +
      "  Pass an explicit one: npm run dev -- --port 9000"
  );
}

/**
 * Both ports a project's dev environment needs, guaranteed distinct.
 *
 * The API's preferred port is derived from the one the dev server actually
 * got, not from the config: with three projects running, config-relative
 * numbering hands the same API port to two of them. Deriving it from the real
 * server port keeps each project's pair together and readable —
 * `8000/8001`, `8002/8003`, `8004/8005`.
 *
 * @returns {Promise<{ port: number, apiPort: number, movedFrom: number | null }>}
 */
export async function allocateDevPorts({ port, apiPort, host = "127.0.0.1" } = {}) {
  const requested = port;
  const server = await findFreePort(port, { host });
  const api = await findFreePort(apiPort ?? server + 1, { host, skip: [server] });
  return { port: server, apiPort: api, movedFrom: server === requested ? null : requested };
}
