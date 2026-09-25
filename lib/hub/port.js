/**
 * Which port the console listens on, decided before anything else starts.
 *
 * The common way a first start fails is a port that is already taken. Two
 * different situations hide behind that one error, and they need opposite
 * answers:
 *
 *   - Agent Console itself is already running there. Starting a second one on
 *     the same state directory would have two processes writing one set of
 *     files, so the answer is to point at the one that is running.
 *   - Some other program has the port. Then the default port simply moves to
 *     the next free one, and the console prints the address it really used.
 *
 * A port the person chose explicitly (--port, AGENT_CONSOLE_PORT) is never
 * moved: they asked for it, so they are told it is busy instead.
 */

import net from "node:net";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** True when this process could listen on host:port right now. */
export function portFree(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** What an Agent Console answering on this machine's port says about itself, or null. */
export async function agentConsoleAt(port, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/hello`, {
      signal: AbortSignal.timeout(1500), redirect: "error", cache: "no-store",
    });
    if (!response.ok) return null;
    const info = await response.json();
    return info && info.product === "Agent Console" ? info : null;
  } catch {
    return null;
  }
}

async function usable(port, host) {
  if (!(await portFree(port, host))) return false;
  // The console answers only on loopback, so loopback must be free as well.
  return LOOPBACK.has(host) || portFree(port, "127.0.0.1");
}

/**
 * @param {object} options
 * @param {number} options.port        the requested port (0 = any free port)
 * @param {string} options.host        the --listen address
 * @param {boolean} options.explicit   the person chose this port
 * @param {boolean} options.demo       this start is a demo
 * @param {Function} [options.mine]    async (port, info) => true when the console
 *   answering on a port the scan reaches is this state directory's own; without
 *   it, any console of the same kind (demo or not) is taken as this one
 * @returns {Promise<{action: "listen"|"already-running"|"busy", port: number, movedFrom?: number, running?: object}>}
 */
export async function choosePort({ port, host, explicit = false, demo = false, tries = 20, fetchImpl, avoid = [], mine = null }) {
  if (port === 0) return { action: "listen", port };
  const running = await agentConsoleAt(port, fetchImpl);
  // A demo and a real console are different things; one never stands in for the other.
  if (running && Boolean(running.demo) === Boolean(demo)) return { action: "already-running", port, running };
  if (!running && await usable(port, host)) return { action: "listen", port };
  if (explicit) return { action: "busy", port, ...(running ? { running } : {}) };
  for (let next = port + 1; next <= Math.min(65_535, port + tries); next += 1) {
    // This console, already running on the port it moved to last time: point
    // at it rather than start a second one on the same state directory.
    const other = await agentConsoleAt(next, fetchImpl);
    if (other && Boolean(other.demo) === Boolean(demo) && (!mine || await mine(next, other))) {
      return { action: "already-running", port: next, running: other };
    }
    if (avoid.includes(next) || other) continue;
    if (await usable(next, host)) return { action: "listen", port: next, movedFrom: port };
  }
  return { action: "busy", port };
}

/** A free port for reporting: the one asked for, or (unless it was chosen explicitly) the next free one. */
export async function chooseFreePort({ port, host, explicit = false, avoid = [], tries = 20 }) {
  if (port === 0) return { action: "listen", port };
  if (!avoid.includes(port) && await usable(port, host)) return { action: "listen", port };
  if (explicit) return { action: "busy", port };
  for (let next = port + 1; next <= Math.min(65_535, port + tries); next += 1) {
    if (!avoid.includes(next) && await usable(next, host)) return { action: "listen", port: next, movedFrom: port };
  }
  return { action: "busy", port };
}
