// @effect-diagnostics nodeBuiltinImport:off
// ru-code: `ru-code env-analysis` — a READ-ONLY capability probe. Run it against a
// live daemon (with a real acp session) to learn, per machine, which kill methods
// are available and which actually reach the children:
//   • signature (posix): is pgrep present? does `pgrep -f <sig>` match? (pgrep
//     LISTS — never pkill here, which would kill the acp and blank the other probes)
//   • group/tree (posix): server pid/pgid vs each child's ppid/pgid → does the
//     child share the group (→ `kill -9 -<pgid>` reaches it) or is it reparented?
//   • tree (windows): which enumerators run (tasklist/wmic/powershell) + does
//     `taskkill /F /T /PID` actually kill a spawned dummy child?
//   • tracked-pid: the recorded server pid + liveness (the always-available floor)

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { PROCESSES_SIGNATURES } from "./constants.ts";
import { readRuntimeState } from "./runtimeState.ts";
import { isProcessAlive } from "./signal.ts";

const run = (command: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync(command, [...args], {
    encoding: "utf8",
    timeout: 4_000,
    windowsHide: true,
  });

/** Run a command, report only whether it worked (for capability checks). */
const capability = (command: string, args: ReadonlyArray<string>): string => {
  try {
    run(command, args);
    return "ok ✅";
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return `unavailable ❌ (${code ?? "error"})`;
  }
};

const systemRoot = (): string =>
  process.env.SystemRoot ?? process.env.windir ?? String.raw`C:\Windows`;
const sys32 = (...parts: ReadonlyArray<string>): string =>
  NodePath.join(systemRoot(), "System32", ...parts);

interface PsRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly command: string;
}

const parsePsRows = (output: string): ReadonlyArray<PsRow> =>
  output
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              ppid: Number(match[2]),
              pgid: Number(match[3]),
              command: match[4] ?? "",
            },
          ]
        : [];
    });

const posixReport = (serverPid: number | undefined): Array<string> => {
  const out: Array<string> = ["", "[posix] signature strategy (pkill -f):"];

  for (const signature of PROCESSES_SIGNATURES) {
    try {
      const matched = run("pgrep", ["-f", signature]).trim().split("\n").filter(Boolean);
      out.push(
        `  pgrep -f "${signature}" → ${matched.length} match(es): ${matched.join(", ") || "—"}`,
      );
    } catch (cause) {
      out.push(
        (cause as NodeJS.ErrnoException).code === "ENOENT"
          ? `  pgrep NOT present → signatures unavailable on this box`
          : `  pgrep -f "${signature}" → 0 matches (pgrep present)`,
      );
    }
  }

  out.push("", "[posix] group/tree strategy (ps -eo pid,ppid,pgid,command):");
  try {
    const rows = parsePsRows(run("ps", ["-eo", "pid,ppid,pgid,command"]));
    const server = rows.find((row) => row.pid === serverPid);
    const children = rows.filter((row) =>
      PROCESSES_SIGNATURES.some((s) => row.command.includes(s)),
    );
    if (server) {
      out.push(`  server:  pid=${server.pid} ppid=${server.ppid} pgid=${server.pgid}`);
    } else {
      out.push(`  server pid ${serverPid ?? "?"} not found in ps output`);
    }
    if (children.length === 0) {
      out.push("  no acp children found (start a real qwen session, then re-run)");
    }
    for (const child of children) {
      const sameGroup = server ? child.pgid === server.pgid : false;
      const reparented = child.ppid === 1;
      out.push(
        `  child:   pid=${child.pid} ppid=${child.ppid} pgid=${child.pgid}` +
          `  ${sameGroup ? "same group ✓ (kill -9 -pgid reaches it)" : "DIFF group"}` +
          `${reparented ? " REPARENTED(ppid=1)" : ""}`,
      );
    }
  } catch {
    out.push("  ps unavailable");
  }
  return out;
};

const windowsCapabilityReport = (): Array<string> => [
  "",
  "[windows] enumerators / kill tools:",
  `  tasklist:   ${capability(sys32("tasklist.exe"), ["/FO", "CSV", "/NH"])}`,
  `  wmic:       ${capability(sys32("wbem", "wmic.exe"), ["process", "get", "name"])}`,
  `  powershell: ${capability(sys32("WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", "exit 0"])}`,
  `  taskkill:   ${capability(sys32("taskkill.exe"), ["/?"])}`,
];

/** Windows: spawn a dummy child, `taskkill /F /T /PID` it, report whether it died. */
const windowsTaskkillTest = (): Effect.Effect<string> =>
  Effect.gen(function* () {
    const dummy = yield* Effect.sync(() =>
      NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        windowsHide: true,
        stdio: "ignore",
      }),
    );
    const dummyPid = dummy.pid;
    if (dummyPid === undefined) {
      return "  taskkill /T test: could not spawn dummy child";
    }
    yield* Effect.sleep(Duration.millis(300));
    const killed = capability(sys32("taskkill.exe"), ["/F", "/T", "/PID", String(dummyPid)]);
    yield* Effect.sleep(Duration.millis(300));
    const alive = yield* isProcessAlive(dummyPid);
    yield* Effect.sync(() => dummy.kill()); // ensure cleanup if it survived
    return `  taskkill /F /T /PID <dummy>: ${killed} → dummy ${alive ? "SURVIVED ❌" : "killed ✅"}`;
  });

export const runEnvAnalysis = (params: { readonly statePath: string }): Effect.Effect<void> =>
  Effect.gen(function* () {
    const lines: Array<string> = [];
    const platform = yield* HostProcessPlatform;
    const architecture = yield* HostProcessArchitecture;
    lines.push("", "── Ru Code env-analysis (read-only) ──");
    lines.push(`platform: ${platform} (${architecture})   node ${process.version}`);

    const state = yield* readRuntimeState(params.statePath);
    let serverPid: number | undefined;
    if (Option.isNone(state)) {
      lines.push("daemon: no server-runtime.json (not started?)");
    } else {
      serverPid = state.value.pid;
      const alive = yield* isProcessAlive(serverPid);
      lines.push(
        `daemon: pid ${serverPid}, port ${state.value.port}, alive: ${alive ? "yes" : "no"}`,
      );
    }

    if (platform === "win32") {
      lines.push(...windowsCapabilityReport());
      lines.push(yield* windowsTaskkillTest());
    } else {
      lines.push(...posixReport(serverPid));
    }

    lines.push("");
    yield* Console.log(lines.join("\n"));
  });
