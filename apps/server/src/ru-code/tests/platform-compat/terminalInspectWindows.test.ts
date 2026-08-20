// ru-code: pins the PowerShell-free Windows foreground inspection. On a non-Windows dev/CI
// host the console-list addon is unavailable by design — the inspector must degrade to a
// SILENT idle result (never a per-second failure), which is also the behaviour on a Windows
// box whose addon failed to load. The tasklist CSV name parse is pinned with real-shaped
// fixtures (quoted fields, /nh no-header output).

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../../../processRunner.ts";
import {
  inspectWindowsSubprocessCompat,
  parseTasklistImageName,
} from "../../platform-compat/terminalInspectWindows.ts";

describe("parseTasklistImageName", () => {
  it("reads the image name from a /fo csv /nh line", () => {
    expect(parseTasklistImageName('"node.exe","12345","Console","1","54 321 K"\r\n')).toBe(
      "node.exe",
    );
  });

  it("skips tasklist chatter and finds the first data row", () => {
    const output = 'INFO: No tasks are running…\r\n"vim.exe","777","Console","1","1,024 K"\r\n';
    expect(parseTasklistImageName(output)).toBe("vim.exe");
  });

  it("no data rows ⇒ null", () => {
    expect(parseTasklistImageName("INFO: No tasks are running.\r\n")).toBe(null);
    expect(parseTasklistImageName("")).toBe(null);
  });
});

/** Runner that fails the test if the inspector spawns anything on the idle path. */
const explodingProcessRunner = Layer.succeed(
  ProcessRunner.ProcessRunner,
  ProcessRunner.ProcessRunner.of({
    run: (input) => Effect.die(new Error(`unexpected spawn: ${input.command}`)),
  }),
);

describe("inspectWindowsSubprocessCompat without the console-list addon", () => {
  it.effect("degrades to a silent idle result (no failure, no spawns)", () =>
    Effect.gen(function* () {
      const result = yield* inspectWindowsSubprocessCompat(4242).pipe(
        Effect.provide(explodingProcessRunner),
      );
      expect(result).toEqual({
        hasRunningSubprocess: false,
        childCommand: null,
        processIds: [4242],
      });
    }),
  );
});
