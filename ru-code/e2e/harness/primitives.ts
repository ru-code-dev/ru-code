// ru-code: E2E HARNESS — primitives.
//
// The bottom layer every installed-app suite stands on: assertions that fail loudly, a bounded
// poll (there are NO bare sleeps in this harness — a sleep is a guess, a poll is a fact), a child
// process runner, loopback port helpers, a tiny HTTP/JSON client, temp dirs, and a LIFO cleanup
// registry so a suite that dies half-way still takes its sandboxes and servers with it.
//
// Nothing here knows about any product feature. Feature-specific fixtures and observers live in
// `ru-code/e2e/features/<feature>/`.
//
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// ── repo locations ─────────────────────────────────────────────────────────────────────────────
export const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../..");
export const SERVER_DIST = NodePath.join(REPO_ROOT, "apps/server/dist");
export const DIST_BUNDLE = NodePath.join(REPO_ROOT, "dist-bundle");
export const WEB_DIST = NodePath.join(REPO_ROOT, "apps/web/dist");

// ── tiny helpers ───────────────────────────────────────────────────────────────────────────────
export const log = (message: string): void => process.stdout.write(`${message}\n`);
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class AssertionError extends Error {}
export const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new AssertionError(message);
};
export const assertEq = (actual: unknown, expected: unknown, message: string): void => {
  if (actual !== expected) {
    throw new AssertionError(
      `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
};

/** Poll `probe` until it returns a truthy value, or throw after `timeoutMs`. NO bare sleeps in specs. */
export async function poll<T>(
  probe: () => Promise<T | null | undefined | false>,
  options: { readonly timeoutMs: number; readonly intervalMs: number; readonly label: string },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw new AssertionError(
        `poll timed out (${options.timeoutMs}ms): ${options.label} — last: ${JSON.stringify(last)}`,
      );
    }
    await sleep(options.intervalMs);
  }
}

// ── global cleanup registry (LIFO) ───────────────────────────────────────────────────────────
export const cleanups: Array<() => void | Promise<void>> = [];
export async function runAllCleanups(): Promise<void> {
  for (const fn of cleanups.toReversed()) {
    try {
      await fn();
    } catch {
      // best-effort
    }
  }
  cleanups.length = 0;
}

// ── low-level process + net helpers ──────────────────────────────────────────────────────────
export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export function runNode(
  args: ReadonlyArray<string>,
  options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(process.execPath, [...args], {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr });
    });
  });
}

/** A free loopback port (bind :0, read, release). Used the instant before a boot to minimise races. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Occupy a port with a listener and HOLD it until the returned release() is called. */
export function holdPort(port: number): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer((socket) => socket.destroy());
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const release = (): Promise<void> => new Promise((done) => server.close(() => done()));
      cleanups.push(release);
      resolve(release);
    });
  });
}

export interface HealthzBody {
  readonly ok: boolean;
  readonly version: string;
  readonly pid: number;
  readonly lastApply: {
    readonly outcome: string;
    readonly reasonCode: string | null;
    readonly targetVersion: string;
  } | null;
}
export function httpJson(
  method: string,
  url: string,
  timeoutMs: number,
): Promise<{ readonly status: number; readonly body: unknown } | null> {
  return new Promise((resolve) => {
    const request = NodeHttp.request(url, { method, timeout: timeoutMs }, (response) => {
      let raw = "";
      response.on("data", (d: Buffer) => (raw += d.toString()));
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: raw === "" ? null : JSON.parse(raw) });
        } catch {
          resolve({ status: response.statusCode ?? 0, body: null });
        }
      });
    });
    request.on("error", () => resolve(null));
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.end();
  });
}
export const getHealthz = async (port: number): Promise<HealthzBody | null> => {
  const response = await httpJson("GET", `http://127.0.0.1:${String(port)}/healthz`, 2000);
  return response !== null && response.status === 200 ? (response.body as HealthzBody) : null;
};

// ── fs helpers ───────────────────────────────────────────────────────────────────────────────
// EVERY e2e temp path (harness or spec) must live under here — never bare os.tmpdir() — so a
// single `rm -rf` of this one directory (see `e2e:clean-up` in package.json) reclaims 100% of
// what this suite ever creates, with zero risk of touching anything else under /tmp.
export const RU_CODE_TMP_ROOT = NodePath.join(NodeOS.tmpdir(), "ru-code");
export const mkTemp = (prefix: string): string => {
  NodeFS.mkdirSync(RU_CODE_TMP_ROOT, { recursive: true });
  const dir = NodeFS.mkdtempSync(NodePath.join(RU_CODE_TMP_ROOT, prefix));
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
export const readJsonFile = (file: string): unknown => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
