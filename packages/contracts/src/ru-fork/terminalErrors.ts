// ru-fork: localized (Russian) user-facing messages for terminal errors.
//
// Lives here — NOT inline in the upstream `terminal.ts` — so re-syncs from
// upstream t3code don't conflict, and so the WEB can rebuild the message from a
// wire-decoded error object: the class `message` getters in `terminal.ts` are
// lost over the RPC boundary (only the schema data fields survive), which is
// why a failed terminal open showed a generic "Failed to open terminal"
// instead of the real reason.
//
// Returns `undefined` for an unrecognized tag so callers can fall back to a
// generic message (or the raw `Error.message`).

export interface TerminalErrorShape {
  readonly _tag?: string;
  readonly cwd?: string;
  readonly reason?: string;
  readonly operation?: string;
  readonly cause?: unknown;
}

export function terminalErrorMessage(error: TerminalErrorShape): string | undefined {
  switch (error._tag) {
    case "TerminalCwdError": {
      const cwd = error.cwd ?? "";
      if (error.reason === "notDirectory") {
        return `Рабочий каталог терминала не является папкой: ${cwd}`;
      }
      if (error.reason === "notFound") {
        return `Рабочий каталог терминала не существует: ${cwd}`;
      }
      const causeMessage =
        error.cause !== undefined &&
        error.cause !== null &&
        typeof error.cause === "object" &&
        "message" in error.cause
          ? (error.cause as { readonly message?: unknown }).message
          : undefined;
      return typeof causeMessage === "string" && causeMessage.length > 0
        ? `Не удалось открыть рабочий каталог терминала: ${cwd} (${causeMessage})`
        : `Не удалось открыть рабочий каталог терминала: ${cwd}`;
    }
    case "TerminalHistoryError":
      return `Не удалось загрузить историю терминала (операция: ${error.operation ?? "?"}).`;
    case "TerminalSessionLookupError":
      return "Сессия терминала не найдена.";
    case "TerminalNotRunningError":
      return "Терминал не запущен.";
    default:
      return undefined;
  }
}
