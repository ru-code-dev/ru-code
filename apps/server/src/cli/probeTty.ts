// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
//
// `ru-fork probe-tty` — standalone terminal/PTY diagnostic.
//
// Loads node-pty exactly the way the running app does (require relative to this
// bundled cli.js), reports WHERE it resolves from and which native artifacts are
// present, then tries to spawn a real shell with BOTH backends:
//   1. default (system ConPTY — useConptyDll=false): only conpty.node + the OS's
//      signed conhost; the AppLocker-friendly path.
//   2. bundled ConPTY (useConptyDll=true): loads conpty.dll and launches the
//      bundled OpenConsole.exe — the AppLocker/DLL-sensitive path.
//
// Self-contained: needs no server config/preflight, so it still runs on a locked
// box where the server itself refuses to start. The real import/spawn error is
// always surfaced (each is wrapped) so we learn exactly what's wrong.

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

const out = (text: string): void => void process.stderr.write(`${text}\n`);

// Resolve node-pty relative to THIS module (the bundled cli.js) — i.e. exactly
// where the app would load it from at runtime.
const requireForApp = createRequire(import.meta.url);

// "Where would the app load node-pty from" — informational, never fatal.
const resolveNodePty = (): { entry?: string; dir?: string; error?: string } => {
  try {
    const entry = requireForApp.resolve("node-pty");
    let dir: string | undefined;
    try {
      dir = path.dirname(requireForApp.resolve("node-pty/package.json"));
    } catch {
      // package.json not exported — derive the package dir from the entry path.
      const marker = `${path.sep}node-pty${path.sep}`;
      const at = entry.lastIndexOf(marker);
      if (at >= 0) dir = entry.slice(0, at + marker.length - 1);
    }
    return { entry, ...(dir !== undefined ? { dir } : {}) };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
};

const reportArtifacts = (nodePtyDir: string): void => {
  const tag = `${process.platform}-${process.arch}`;
  const candidates = [
    `prebuilds/${tag}/pty.node`,
    `prebuilds/${tag}/conpty.node`,
    `prebuilds/${tag}/conpty/conpty.dll`,
    `prebuilds/${tag}/conpty/OpenConsole.exe`,
    `build/Release/pty.node`,
    `build/Release/conpty.node`,
  ];
  out("  native artifacts in the loaded node-pty:");
  for (const relative of candidates) {
    const full = path.join(nodePtyDir, relative);
    out(`    ${fs.existsSync(full) ? "present" : "absent "}  ${relative}`);
  }
};

const defaultShell = (): string =>
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")
    : (process.env.SHELL ?? "/bin/sh");

const attemptSpawn = async (label: string, extra: Record<string, unknown>): Promise<void> => {
  out("");
  out(`--- attempt: ${label} ---`);

  let nodePty: typeof import("node-pty");
  try {
    nodePty = await import("node-pty");
  } catch (cause) {
    // The most likely AppLocker-DLL symptom: conpty.node refuses to load.
    out(`  import node-pty FAILED: ${cause instanceof Error ? cause.message : String(cause)}`);
    if (cause instanceof Error && cause.stack) {
      out(`  stack: ${cause.stack.split("\n").slice(1, 4).join(" | ")}`);
    }
    return;
  }

  const shell = defaultShell();
  out(`  shell : ${shell}`);

  try {
    const options: Record<string, unknown> = {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
      name: process.platform === "win32" ? "xterm-color" : "xterm-256color",
      ...extra,
    };
    const child = nodePty.spawn(shell, [], options as Parameters<typeof nodePty.spawn>[2]);
    out(`  SPAWNED OK — pid ${child.pid}`);

    // Read the first chunk (or time out) to confirm the data pipe actually works.
    const firstOutput = await new Promise<string>((resolve) => {
      let buffer = "";
      const subscription = child.onData((data) => {
        buffer += data;
        if (buffer.length > 0) {
          subscription.dispose();
          resolve(buffer);
        }
      });
      setTimeout(() => {
        subscription.dispose();
        resolve(buffer);
      }, 1500);
    });
    out(`  first output: ${JSON.stringify(firstOutput.slice(0, 120))}`);

    child.kill();
    out("  PTY WORKS ✓");
  } catch (cause) {
    out(`  SPAWN FAILED: ${cause instanceof Error ? cause.message : String(cause)}`);
    if (cause instanceof Error && cause.stack) {
      out(`  stack: ${cause.stack.split("\n").slice(1, 4).join(" | ")}`);
    }
  }
};

const runProbeTty = async (): Promise<void> => {
  out("== ru-fork probe-tty ==");
  out(`platform : ${process.platform} ${os.release()}`);
  out(`arch     : ${process.arch}`);
  out(`node     : ${process.version}  (${process.execPath})`);
  out(`cwd      : ${process.cwd()}`);
  out(`env NODE_PATH = ${process.env.NODE_PATH ?? "(unset)"}`);

  const resolved = resolveNodePty();
  if (resolved.error || !resolved.entry) {
    out(`node-pty : RESOLVE FAILED — ${resolved.error ?? "unknown"}`);
  } else {
    out(`node-pty entry   : ${resolved.entry}`);
    out(`node-pty package : ${resolved.dir ?? "(could not derive dir)"}`);
    if (resolved.dir) reportArtifacts(resolved.dir);
  }

  // Default backend first (system ConPTY), then the bundled OpenConsole.exe path
  // on Windows so an AppLocker/DLL failure is pinpointed to one or the other.
  await attemptSpawn("default (system ConPTY — useConptyDll=false)", {});
  if (process.platform === "win32") {
    await attemptSpawn("bundled ConPTY (useConptyDll=true → conpty.dll + OpenConsole.exe)", {
      useConptyDll: true,
    });
  }

  out("");
  out("== probe-tty done ==");
};

export const probeTtyCommand = Command.make("probe-tty").pipe(
  Command.withDescription(
    "Diagnose the terminal/PTY backend: where node-pty loads from, which native " +
      "artifacts are present, and whether it can spawn a shell (system ConPTY vs " +
      "bundled OpenConsole.exe). Prints a report to stderr; does not start the server.",
  ),
  Command.withHandler(() => Effect.promise(() => runProbeTty())),
);
