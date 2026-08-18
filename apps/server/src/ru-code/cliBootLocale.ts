// ru-code: seed the process locale from argv/env BEFORE any effect/CLI module loads.
//
// Why a dedicated pre-parse (not the existing `--language` handling in cli/config.ts):
// CLI flag/command descriptions are evaluated at MODULE LOAD (`Flag.withDescription(...)`
// runs when the flag const is constructed), and `--help` short-circuits before the command
// handler — so `resolveServerConfig`'s runtime `setLocaleOverride` is far too late to affect
// help text. To make `--lang en` actually flip `--help` to English (and default to Russian),
// the locale must be pinned before the flag modules — and the patched effect built-in flags
// (--help/--version/--completions/--log-level) — are constructed.
//
// This module is imported FIRST in bin.ts (before the effect imports) purely for its side
// effect. It must stay effect-free (@ru-code/localization is zero-effect) so importing it
// never triggers effect/cli to load ahead of the seed.
//
// Two sinks, one source:
//   • setLocaleOverride(locale) — pins @ru-code/localization's runtime L()/LT(), which the
//     build transform's wrapped display strings (our config.ts/server.ts/bin.ts descriptions)
//     read at their module-load evaluation.
//   • globalThis.__RU_CLI_LOCALE__ — read by the effect patch (patches/effect@*.patch) for the
//     four framework flag descriptions; a node_modules patch can't cleanly import workspace L(),
//     so it reads this global, seeded here from the same resolved locale.

import { getLocale, isLocale, setLocaleOverride, type Locale } from "@ru-code/localization";

// Scan argv for an explicit `--language`/`--lang` (space or `=` form). Returns the last valid
// occurrence's value, else undefined. Exported so the precedence logic is unit-tested in our zone.
export function readLocaleFromArgv(argv: readonly string[]): Locale | undefined {
  let found: Locale | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--language" || arg === "--lang") {
      const next = argv[i + 1];
      if (isLocale(next)) found = next;
    } else if (arg.startsWith("--language=") || arg.startsWith("--lang=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      if (isLocale(value)) found = value;
    }
  }
  return found;
}

// Pure locale decision. Precedence mirrors cli/config.ts: an explicit `--language`/`--lang`
// flag beats the T3CODE_LANG env var; absent both, undefined (the default Russian stands).
export function resolveCliLocale(
  argv: readonly string[],
  env: Record<string, string | undefined> | undefined,
): Locale | undefined {
  const fromArgv = readLocaleFromArgv(argv);
  const envValue = env?.T3CODE_LANG;
  const fromEnv = isLocale(envValue) ? envValue : undefined;
  return fromArgv ?? fromEnv;
}

function seedCliLocale(): void {
  const proc = (
    globalThis as { process?: { argv?: string[]; env?: Record<string, string | undefined> } }
  ).process;
  const chosen = resolveCliLocale(proc?.argv ?? [], proc?.env);
  if (chosen) setLocaleOverride(chosen);
  // Always publish the effective locale (default "ru") so the effect patch reads a real value.
  (globalThis as { __RU_CLI_LOCALE__?: Locale }).__RU_CLI_LOCALE__ = getLocale();
}

seedCliLocale();
