// ru-code: locks in the installed CLI's `--help` surface. The `auth`/`project`
// subcommands and the internal/dev flags stay fully invocable but are hidden
// from help via Command.withHidden / Flag.withHidden. We assert the real
// rendered `--help` text (the actual user-facing contract) plus that a hidden
// flag is still parsed (rejected as InvalidValue, not UnrecognizedOption) — i.e.
// hidden, not removed.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import { cli } from "../../../bin.ts";

const runLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const renderHelp = Effect.gen(function* () {
  yield* Command.runWith(cli, { version: "0.0.0" })(["--help"]).pipe(Effect.exit);
  const lines = yield* TestConsole.logLines;
  return lines.filter((line): line is string => typeof line === "string").join("\n");
}).pipe(Effect.provide(Layer.mergeAll(runLayer, TestConsole.layer)));

const KEPT_FLAGS = ["--mode", "--port", "--host", "--base-dir", "--no-browser"];
const HIDDEN_FLAGS = [
  "--dev-url",
  "--bootstrap-fd",
  "--auto-bootstrap-project-from-cwd",
  "--log-websocket-events",
  "--tailscale-serve",
  "--tailscale-serve-port",
  "--json", // ru-code: the installer's launch contract, not a user-facing option
];

// Tests run in the default EN locale (VITEST ⇒ en; the effect patch defaults to English
// when __RU_CLI_LOCALE__ is unset). Because L(en, ru) === en in EN locale, the rendered help
// is observationally the English source — so we assert the English text here (the EN-identity
// that proves the wiring). The Russian rendering is proven separately by the dict/catalog
// gates (genCatalog --strict pairs every English string with its Russian).
it.effect("--help lists the kept flags + both server subcommands", () =>
  Effect.gen(function* () {
    const help = yield* renderHelp;
    for (const flag of KEPT_FLAGS) {
      assert.include(help, flag);
    }
    assert.include(help, "start");
    assert.include(help, "serve");
    assert.include(help, "Run the Ru Code server.");
    assert.include(help, "Application base directory");
  }),
);

it.effect("--help wires global flags, the choices label, and our flag text", () =>
  Effect.gen(function* () {
    const help = yield* renderHelp;
    // effect-CLI framework built-ins (locale-aware via the effect patch).
    assert.include(help, "Show help information");
    assert.include(help, "Show version information");
    assert.include(help, "Print shell completion script");
    assert.include(help, "Sets the minimum log level");
    assert.notInclude(help, "Показать справку");
    // the framework "(choices: …)" label.
    assert.include(help, "choices:");
    assert.notInclude(help, "варианты:");
    // our flag/arg descriptions.
    assert.include(help, "for example 127.0.0.1)");
    assert.notInclude(help, "Tailnet");
    assert.include(help, "defaults to the Project directory");
    assert.notInclude(help, "T3CODE_HOME");
  }),
);

it.effect("--help hides the internal flags and the auth/project subcommands", () =>
  Effect.gen(function* () {
    const help = yield* renderHelp;
    for (const flag of HIDDEN_FLAGS) {
      assert.notInclude(help, flag);
    }
    assert.notMatch(help, /\bauth\b/);
    assert.notMatch(help, /\bproject\b/);
  }),
);

it.effect("a hidden flag is still parsed (InvalidValue inside ShowHelp, not Unrecognized)", () =>
  Effect.gen(function* () {
    // A bad value for a hidden flag must be *validated* (InvalidValue) — proving
    // the flag is still recognized. A removed flag would surface as
    // UnrecognizedOption instead. effect-cli wraps parse errors in ShowHelp.
    const error = yield* Command.runWith(cli, { version: "0.0.0" })([
      "--tailscale-serve-port",
      "not-a-number",
    ]).pipe(Effect.flip);
    assert.isTrue(CliError.isCliError(error));
    if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
      return assert.fail(`expected ShowHelp, got ${String((error as { _tag?: string })._tag)}`);
    }
    const wrappedTags = error.errors.map((wrapped) => wrapped._tag);
    assert.include(wrappedTags, "InvalidValue");
    assert.notInclude(wrappedTags, "UnrecognizedOption");
    assert.isTrue(
      error.errors.some(
        (wrapped) => wrapped._tag === "InvalidValue" && wrapped.option === "tailscale-serve-port",
      ),
      `expected InvalidValue for tailscale-serve-port, got: ${wrappedTags.join(",")}`,
    );
  }).pipe(Effect.provide(runLayer)),
);

// ru-code: --json is the installer's launch contract. It must be RECOGNIZED (an
// unknown flag would abort the launch the installer is waiting on) while staying
// out of --help. Parsing is proven by what it is NOT: the run below fails only on
// the deliberately bad tailscale value, never with UnrecognizedOption for --json.
it.effect("--json is recognized (hidden, not removed)", () =>
  Effect.gen(function* () {
    const error = yield* Command.runWith(cli, { version: "0.0.0" })([
      "--json",
      "--tailscale-serve-port",
      "not-a-number",
    ]).pipe(Effect.flip);
    if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
      return assert.fail(`expected ShowHelp, got ${String((error as { _tag?: string })._tag)}`);
    }
    assert.isFalse(
      error.errors.some((wrapped) => wrapped._tag === "UnrecognizedOption"),
      `--json must parse; got: ${error.errors.map((wrapped) => wrapped._tag).join(",")}`,
    );
  }).pipe(Effect.provide(runLayer)),
);
