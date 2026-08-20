// @effect-diagnostics nodeBuiltinImport:off
// ru-code: stop the background daemon. Reads the pid from the state file, kills it
// via the shared graceful-terminate routine (SIGTERM → drain → SIGKILL; --force =
// immediate SIGKILL), then clears the state file. `process.kill` is a built-in
// syscall — no external command, so it works on locked-down machines.

import * as NodeFSP from "node:fs/promises";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { L } from "@ru-code/localization";

import { formatBrandNotice } from "./banner.ts";
import { failWith } from "./report.ts";
import { readRuntimeState } from "./runtimeState.ts";
import { isProcessAlive } from "./signal.ts";
import { reapOrphanedChildren, terminateInstance } from "./terminate.ts";

const clearStateFile = (statePath: string): Effect.Effect<void> =>
  Effect.tryPromise(() => NodeFSP.rm(statePath, { force: true })).pipe(
    Effect.orElseSucceed(() => undefined),
  );

export const stopDaemon = (params: {
  readonly statePath: string;
  readonly force: boolean;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const state = yield* readRuntimeState(params.statePath);
    if (Option.isNone(state) || !(yield* isProcessAlive(state.value.pid))) {
      // No live daemon — but a CRASHED server may have left journaled acp
      // orphans behind. `stop` means "nothing left running", so reap them here
      // (not just on the next start), then clean the stale state file.
      yield* reapOrphanedChildren(params.statePath, params.force ? { force: true } : undefined);
      yield* clearStateFile(params.statePath);
      yield* Console.log(formatBrandNotice("info", L("is not running", "не запущен")));
      return;
    }

    const { pid } = state.value;
    const confirmedDead = yield* terminateInstance({
      pid,
      force: params.force,
      statePath: params.statePath,
    });
    if (!confirmedDead) {
      // The pid was alive and survived our kill (SIGKILL / taskkill /F /T) — most
      // likely a policy-blocked taskkill on Windows. Leave the state file so a
      // retry / the next launch can still find it, and exit non-zero so a caller
      // (the reinstall's `cli.js stop`) can tell "stopped" from "still running".
      return yield* failWith(
        L(
          `Could not stop the daemon (pid ${pid} is still running).`,
          `Не удалось остановить демон (pid ${pid} всё ещё работает).`,
        ),
      );
    }
    yield* clearStateFile(params.statePath);
    yield* Console.log(
      formatBrandNotice("ok", L(`stopped (pid ${pid})`, `остановлен (pid ${pid})`)),
    );
  });
