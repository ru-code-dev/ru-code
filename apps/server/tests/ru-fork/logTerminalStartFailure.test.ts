// ru-fork: proof that a failed terminal open is LOGGED to the server (the RPC
// observability seam is a no-op since telemetry was removed) AND that the
// failure is re-raised unchanged — so every caller keeps its error handling and
// the typed TerminalError still propagates.
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import { logTerminalStartFailure } from "../../src/ru-fork/terminal/logTerminalStartFailure.ts";

function captureLogs() {
  const lines: string[] = [];
  const logger = Logger.make(({ message }) => {
    lines.push(Array.isArray(message) ? message.map((part) => String(part)).join(" ") : String(message));
  });
  return { lines, layer: Logger.layer([logger], { mergeWithExisting: false }) };
}

describe("logTerminalStartFailure", () => {
  it("logs the real reason and re-raises the failure unchanged", async () => {
    const { lines, layer } = captureLogs();
    const cause = new Error("Terminal cwd does not exist: C:/x");

    const exit = await Effect.runPromiseExit(
      Effect.fail(cause).pipe(
        logTerminalStartFailure({ threadId: "thread-1", cwd: "C:/x" }),
        Effect.provide(layer),
      ),
    );

    // re-raised, not swallowed
    expect(exit._tag).toBe("Failure");
    // logged at the server
    expect(lines.some((line) => line.includes("terminal start failed"))).toBe(true);
  });

  it("does not log on success", async () => {
    const { lines, layer } = captureLogs();

    const value = await Effect.runPromise(
      Effect.succeed(42).pipe(
        logTerminalStartFailure({ threadId: "thread-1", cwd: "C:/x" }),
        Effect.provide(layer),
      ),
    );

    expect(value).toBe(42);
    expect(lines).toHaveLength(0);
  });
});
