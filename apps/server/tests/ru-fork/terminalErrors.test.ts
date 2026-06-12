// ru-fork: the terminal-error formatter rebuilds the localized, user-facing
// message from a WIRE-DECODED error object (the tagged error's `message` getter
// is lost over the RPC boundary). This is the proof that a failed terminal open
// surfaces the REAL reason in the UI instead of a generic fallback.
import { describe, expect, it } from "vitest";
import { terminalErrorMessage } from "@t3tools/contracts";

describe("terminalErrorMessage", () => {
  it("formats a missing cwd (notFound)", () => {
    expect(
      terminalErrorMessage({ _tag: "TerminalCwdError", cwd: "C:/x", reason: "notFound" }),
    ).toBe("Рабочий каталог терминала не существует: C:/x");
  });

  it("formats a cwd that is not a directory", () => {
    expect(
      terminalErrorMessage({ _tag: "TerminalCwdError", cwd: "C:/x", reason: "notDirectory" }),
    ).toBe("Рабочий каталог терминала не является папкой: C:/x");
  });

  it("formats a stat failure, including the underlying cause message", () => {
    expect(
      terminalErrorMessage({
        _tag: "TerminalCwdError",
        cwd: "C:/x",
        reason: "statFailed",
        cause: new Error("PermissionDenied"),
      }),
    ).toBe("Не удалось открыть рабочий каталог терминала: C:/x (PermissionDenied)");
  });

  it("formats a stat failure without a usable cause message", () => {
    expect(
      terminalErrorMessage({ _tag: "TerminalCwdError", cwd: "C:/x", reason: "statFailed" }),
    ).toBe("Не удалось открыть рабочий каталог терминала: C:/x");
  });

  it("formats a history error", () => {
    expect(terminalErrorMessage({ _tag: "TerminalHistoryError", operation: "read" })).toBe(
      "Не удалось загрузить историю терминала (операция: read).",
    );
  });

  it("returns undefined for an unknown tag so callers fall back", () => {
    expect(terminalErrorMessage({ _tag: "SomethingElse" })).toBeUndefined();
    expect(terminalErrorMessage({})).toBeUndefined();
  });
});
