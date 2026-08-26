#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// ru-code: assemble the standalone `install` bash script from parts.
//
// The installer ships as ONE self-contained file (`install` at the repo root) — the
// `git clone && bash ru-code/install` contract has no build step on the user's machine.
// But a ~1000-line bash blob is unmaintainable, so we AUTHOR it as ordered parts under
// `ru-code/installer/parts/*.sh` and concatenate them here, injecting brand + config values
// (single source of truth) into `@@TOKEN@@` placeholders. `install` is the GENERATED, committed
// artifact; edit the parts, run `pnpm build:installer`, commit both. The drift-guard test
// (ru-code/tests/install/build.test.ts) fails if `install` ≠ this output.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  APP_COMMAND,
  APP_HOME_SLUG,
  APP_NAME,
  APP_REPO_NAME,
  BRAND_GRADIENT_FROM,
  BRAND_GRADIENT_TO,
  SUPPORT_CHANNEL_URL,
  IDENTITY_KEY,
  NODE_BIN_PATHS,
  USE_RC_SOURCED_LAUNCHER,
  cliArgAssignments,
  cliEnvAssignments,
} from "@ru-code/branding";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL(".", import.meta.url)), "..");
const PARTS_DIR = NodePath.join(REPO_ROOT, "ru-code/installer/parts");
const OUTPUT = NodePath.join(REPO_ROOT, "install");

// These mirror apps/server/src/ru-code/preflight/common/constants.ts (a standalone, import-free
// preflight bundle). Kept in sync by hand and GATED by an equivalence test in
// apps/server/src/ru-code/tests/install/build.test.ts (which can import both sides).
const NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";
const CLI_MIN_VERSION = "0.13.1";

/**
 * ru-code: the bash warm-up's env prefix, generated from the branding CLI registry.
 *
 * The warm-up is the fifth qwen spawn site and the only one outside TypeScript, so it takes its
 * variables from the same tables the app's spawns do rather than from a hand-written prefix that
 * could drift. `$CONFIG_DIR` is deliberately a bash variable REFERENCE — the installer resolves
 * the profile dir at run time, so the registry's HOME row is filled with the literal text and
 * expanded by bash, not by us.
 */
function warmUpEnvPrefix(): string {
  return cliEnvAssignments({ HOME: "$CONFIG_DIR" })
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ");
}

/** Minimum major from the engine range (min of every clause's major) — no drift with the range. */
function minMajorFromRange(range: string): string {
  const majors = [...range.matchAll(/(?:\^|>=?|~)(\d+)/g)].map((m) => Number(m[1]));
  if (majors.length === 0)
    throw new Error(`build-installer: cannot derive NODE_MIN_MAJOR from ${range}`);
  return String(Math.min(...majors));
}

// Injected config — the ONE place these installer values live. Brand values come from
// @ru-code/branding; the rest are installer policy/appearance defaults. Bash reads the
// behavior toggles via `${ENV_OVERRIDE:-<injected default>}`, so tests (and power users) can
// override at runtime without editing the shipped file.
const CONFIG: Record<string, string> = {
  // Brand
  APP_DISPLAY_NAME: APP_NAME,
  REPO_NAME: APP_REPO_NAME, // git repo / clone-dir name the installer cd's into
  APP_SLUG: APP_HOME_SLUG, // on-disk identity slug: install log / lock filenames + starter git email
  APP_COMMAND, // bundle filename prefix, e.g. "ru-code"
  // Runtime
  NODE_FLAGS: "--experimental-sqlite --disable-warning=ExperimentalWarning",
  // ru-code: CLI-SHIPPED node runtime — fixed per-OS paths the installer probes BEFORE falling
  // back to the OS node. Injected straight from branding's NODE_BIN_PATHS (the single source,
  // shared with the app's startup preflight). Empty = no shipped runtime (bash skips the probe).
  SHIPPED_NODE_DARWIN: NODE_BIN_PATHS.darwin,
  SHIPPED_NODE_LINUX: NODE_BIN_PATHS.linux,
  SHIPPED_NODE_WIN32: NODE_BIN_PATHS.win32,
  NODE_ENGINE_RANGE,
  NODE_MIN_MAJOR: minMajorFromRange(NODE_ENGINE_RANGE),
  CLI_MIN_VERSION,
  INSTALL_VERSION: "1", // install-FORMAT marker (<bin>/.version), NOT the app version
  // Distribution: standalone source = a DIRECT https URL to a `<APP_COMMAND>-<VERSION>.tgz` bundle
  // (preflight is bundled inside it). Empty = co-located only.
  REMOTE_URL: "",
  // Download timeout (seconds) — curl's own --max-time. Every other step self-bounds (no watchdog).
  DOWNLOAD_TIMEOUT: "120",
  // Check fatality policy (default: only node blocks; git/cli warn and continue).
  NODE_FATAL: "true",
  GIT_FATAL: "false",
  CLI_FATAL: "false",
  // Optional steps (default off).
  CREATE_STARTER_PROJECT: "false",
  // Launcher persistence mode — @ru-code/branding is the single source (see the constant's doc).
  USE_RC_SOURCED_LAUNCHER: USE_RC_SOURCED_LAUNCHER ? "true" : "false",
  // ru-code: the shipped installer starts the app when it is done — a fresh install lands the user
  // in the browser, and an update over a RUNNING app puts it back. Both were "false" here while
  // production shipped them on; that drift is why a locally built installer started nothing.
  START_AFTER_INSTALL: "true",
  RESTART_AFTER_UPDATE: "true",
  // CLI warm-up: fire qwen once (best-effort, non-fatal, log-only) when its bin is present but its
  // profile dir is missing, so the profile exists before the app first spawns it. Timeout in seconds.
  PERFORM_CLI_WARM_UP: "true",
  CLI_WARM_UP_TIMEOUT: "20",
  // ru-code: generated FROM the CLI registry (see warmUpEnvPrefix + RAW_TOKENS). These two are
  // bash FRAGMENTS, not values in a quoted assignment, which is why they bypass the escaper.
  CLI_WARM_UP_ENV: warmUpEnvPrefix(),
  CLI_MCP_OFF_ARGS: cliArgAssignments().join(" "),
  // ru-code: the env-var NAME the warm-up exports the preflight-extracted identity value under
  // (CLI_PASS_IDENTITY). The name comes from the registry (IDENTITY_KEY → the PACKAGE_IDENTITY
  // row), so bash never writes a variable name by hand; the VALUE arrives at install time via the
  // preflight's CLI_IDENTITY stdout line and is exported only when non-empty.
  CLI_IDENTITY_ENV_NAME: IDENTITY_KEY,
  // Hints — bodies for the §10 message table. Placeholders (author-filled).
  CLI_INSTALL_HINT: "Установите CLI-движок (см. документацию проекта).",
  CLI_UPDATE_HINT: "Обновите CLI-движок до последней версии.",
  PACKAGE_MISSING_HINT: "Запустите установщик из каталога, где выполняли git clone.",
  DOWNLOAD_FAILED_HINT: "Проверьте подключение к интернету и повторите попытку.",
  // Credits / contacts. Placeholders until real values are set.
  CREDITS_AUTHOR_FIO: "<автор>",
  CATALOG_URL: "<catalog-url>", // catalog "like" link, shown in the credits box
  // Support channel — the SINGLE source is @ru-code/branding (also used by the frozen wrapper and
  // the SW fallback pages); injected here so the bash script cannot drift from them. An empty value
  // is honoured: the installer omits the support row instead of printing an empty one.
  SUPPORT_CHAT_URL: SUPPORT_CHANNEL_URL, // credits box + crash block + launch banners
  AUTHOR_EMAIL: "<email>", // credits box + crash block
  // Cyan→violet wordmark gradient — the SINGLE source is @ru-code/branding (also used by the daemon
  // banner); injected here as "r;g;b" so the bash script and the daemon can never drift.
  GRADIENT_FROM: BRAND_GRADIENT_FROM.join(";"),
  GRADIENT_TO: BRAND_GRADIENT_TO.join(";"),
};

/**
 * Make a value safe to sit inside a DOUBLE-QUOTED bash assignment, which is where every `@@TOKEN@@`
 * lands (`X="@@TOKEN@@"`, `X="${OVERRIDE:-@@TOKEN@@}"`).
 *
 * Without this, a brand value carrying `$`, a backtick, `"` or `\` either breaks the generated
 * script or EXECUTES at install time — `CREDITS_AUTHOR_FIO="$(id)"` runs `id` on the user's machine.
 * These values are authored by whoever builds the fork rather than typed by a user, so this is a
 * build-time footgun rather than a runtime hole; escaping removes it either way.
 *
 * A no-op for every value that has none of those characters, so today's output is byte-identical.
 */
export function escapeForDoubleQuotedShell(value: string): string {
  return value.replace(/[\\`"$]/g, (character) => `\\${character}`);
}

/**
 * ru-code: the ONLY tokens injected verbatim, without {@link escapeForDoubleQuotedShell}.
 *
 * Both are bash fragments this script GENERATES from the CLI registry — `NAME="$CONFIG_DIR"` env
 * prefixes and flag pairs — rather than brand values someone typed. Escaping them would neutralise
 * exactly the characters that make them work: the quotes that group each assignment and the `$`
 * that defers `CONFIG_DIR` to bash at install time. Every other token keeps its escaping; adding a
 * name here means taking responsibility for that fragment's shell safety at its generator.
 */
const RAW_TOKENS: ReadonlySet<string> = new Set(["CLI_WARM_UP_ENV", "CLI_MCP_OFF_ARGS"]);

/** Deterministic assembly: parts in filename order, tokens replaced, joined by exactly one \n. */
export function buildInstaller(): string {
  const partFiles = NodeFS.readdirSync(PARTS_DIR)
    .filter((name) => name.endsWith(".sh"))
    .sort();
  if (partFiles.length === 0) throw new Error(`no installer parts found in ${PARTS_DIR}`);

  const sections = partFiles.map((name) => {
    const raw = NodeFS.readFileSync(NodePath.join(PARTS_DIR, name), "utf8");
    return raw.replace(/\n+$/, ""); // normalize trailing newlines; we rejoin with a single \n
  });

  let output = `${sections.join("\n\n")}\n`;

  // Inject config tokens. An unresolved @@TOKEN@@ is a build error (never ship a literal token).
  output = output.replace(/@@([A-Z0-9_]+)@@/g, (_match, key: string) => {
    const value = CONFIG[key];
    if (value === undefined) throw new Error(`build-installer: no config value for @@${key}@@`);
    return RAW_TOKENS.has(key) ? value : escapeForDoubleQuotedShell(value);
  });
  const leftover = output.match(/@@[A-Z0-9_]+@@/);
  if (leftover) throw new Error(`build-installer: unresolved token ${leftover[0]}`);

  return output;
}

function main(): void {
  const content = buildInstaller();
  NodeFS.writeFileSync(OUTPUT, content, { mode: 0o755 });
  NodeFS.chmodSync(OUTPUT, 0o755);
  process.stderr.write(`[build-installer] wrote ${OUTPUT} (${content.length} bytes)\n`);
}

// Run when invoked directly; export buildInstaller for the drift-guard test.
if (
  process.argv[1] &&
  NodeFS.realpathSync(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main();
}
