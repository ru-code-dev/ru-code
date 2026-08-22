// ru-code: the frozen launcher `<appRoot>/cli.js` (the "wrapper"). This is the ONE thing users and
// scripts run — `node cli.js …` — and it is FROZEN FOREVER: an install may replace the version dirs and
// the pointer underneath it, but never the wrapper itself, so it must stay brutally simple and never
// grow features. The whole launcher lives here as ONE embedded plain-ESM JavaScript source STRING so it
// survives app bundling and can be written verbatim to disk by prepare-release / the installer.
//
// Its only job is to find the current version and hand off to it: read `<appRoot>/current.json`, verify
// the running node is new enough, then `await import()` the pointed entry IN THE SAME PROCESS (same
// argv, same env — no spawn). It NEVER retries, NEVER spawns a process, NEVER writes a file, NEVER rolls
// back. If anything is wrong it prints a branded terminal banner (matching `ru-code/daemon/src/banner.ts`)
// and exits non-zero — recovery is the user reinstalling, not the wrapper being clever.
//
// The three brand params (appName / appCommand / supportUrl) are baked in by `makeWrapperSource` as
// JSON-stringified `const` literals PREPENDED above the body. The body itself is a `String.raw` template
// with NO `${...}` interpolation and NO template literals inside it (string concatenation only) so it can
// carry ANSI escape bytes and Russian copy verbatim with zero escaping surprises — exactly the discipline
// of an emitted-source template. ESM (`import.meta.url`, top-level `await import`) in a `.js` file
// with no package.json relies on node's module-syntax auto-detection (Node ≥ 20.17 / 22 / 24), which is
// the floor these installs ship on anyway.

/** Brand values baked into the emitted wrapper. All host-facing identity flows in through these. */
export interface WrapperSourceParams {
  /** Product display name (`APP_NAME`) — the gradient wordmark in every banner. */
  readonly appName: string;
  /** The installed CLI program name (`APP_COMMAND`) — shown wherever the banner tells the user to re-run
   * the command. */
  readonly appCommand: string;
  /** Where a user with a broken install is sent (`SUPPORT_CHANNEL_URL`). Empty string ⇒ NO support line
   * is printed at all. */
  readonly supportUrl: string;
}

/**
 * The frozen wrapper body: plain ESM, node builtins only, zero dependencies. String-concatenation only
 * (no template literals / interpolation) so it survives verbatim inside `String.raw`, ANSI bytes and all.
 * The `APP_NAME` / `APP_COMMAND` / `SUPPORT_URL` consts it references are prepended by `makeWrapperSource`.
 */
const WRAPPER_BODY: string = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as process from "node:process";

// ── tiny ANSI palette (matches the daemon banner: cyan→violet wordmark, red arrow) ──────────────────
// Escapes are emitted only on a real terminal; plain text otherwise (piped / captured) so nothing fills
// logs with escape sequences. The gradient endpoints mirror BRAND_GRADIENT_FROM/TO — frozen with the
// wrapper, which is why they are inline literals rather than params.
var TTY = Boolean(process.stdout && process.stdout.isTTY);
var ESC = "[";
var RESET = TTY ? ESC + "0m" : "";
var GRADIENT_FROM = [56, 217, 238]; // cyan
var GRADIENT_TO = [167, 139, 250]; // violet

function paint(codes, text) {
  return TTY ? ESC + codes + "m" + text + RESET : text;
}
function red(text) {
  return paint("31", text);
}
function bold(text) {
  return paint("1", text);
}
function dim(text) {
  return paint("2", text);
}

function gradient(text) {
  if (!TTY) return text;
  var chars = Array.from(text);
  var span = Math.max(1, chars.length - 1);
  var out = "";
  for (var i = 0; i < chars.length; i++) {
    var ch = chars[i];
    if (ch === " ") {
      out += ch;
      continue;
    }
    var t = i / span;
    var r = Math.round(GRADIENT_FROM[0] + (GRADIENT_TO[0] - GRADIENT_FROM[0]) * t);
    var g = Math.round(GRADIENT_FROM[1] + (GRADIENT_TO[1] - GRADIENT_FROM[1]) * t);
    var b = Math.round(GRADIENT_FROM[2] + (GRADIENT_TO[2] - GRADIENT_FROM[2]) * t);
    out += ESC + "1;38;2;" + r + ";" + g + ";" + b + "m" + ch + RESET;
  }
  return out;
}

// A branded notice — "▸ <APP_NAME> <headline>" (red arrow + gradient wordmark), then plain sentence
// lines. Errors go to stderr. Mirrors banner.ts formatErrorNotice / formatBrandNotice.
function printBanner(headline, lines) {
  var rendered = ["", "  " + red("▸") + " " + gradient(APP_NAME) + " " + bold(headline)];
  for (var i = 0; i < lines.length; i++) {
    if (lines[i] === null || lines[i] === undefined) continue;
    rendered.push("  " + lines[i]);
  }
  rendered.push("");
  process.stderr.write(rendered.join("\n") + "\n");
}

// Banner A — the installation is broken (missing/corrupt pointer with no valid fallback, or the entry
// threw on import). Reinstall recommendation + support link; an optional dim technical detail line.
function bannerInstallationBroken(detail) {
  var lines = [
    "Не удалось запустить приложение: установка повреждена или неполна.",
    "Переустановите приложение и запустите снова: " + bold(APP_COMMAND),
  ];
  if (detail !== null && detail !== undefined && detail !== "") lines.push(dim(detail));
  if (SUPPORT_URL !== "") {
    lines.push("Поддержка: " + SUPPORT_URL);
  }
  // headline: «установка повреждена»
  printBanner(
    "установка повреждена",
    lines,
  );
}

// Banner B — the running node is too old. States found vs required and recommends upgrading node.
function bannerNodeTooOld(requiredMajor, currentMajor) {
  var lines = [
    "Установлена устаревшая версия Node.js: " + currentMajor + ".",
    "Требуется Node.js " + requiredMajor + " или новее — обновите Node.js и запустите снова: " + bold(APP_COMMAND),
  ];
  if (SUPPORT_URL !== "") {
    lines.push("Поддержка: " + SUPPORT_URL);
  }
  // headline: «требуется более новая версия Node.js»
  printBanner(
    "требуется более новая версия Node.js",
    lines,
  );
}

function firstLine(err) {
  if (err && typeof err.stack === "string") return err.stack.split("\n")[0];
  return String(err);
}

// ── minimal semver (numeric core only; prerelease ignored for ordering) ─────────────────────────────
function parseSemver(value) {
  if (typeof value !== "string") return null;
  var m = value.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function compareSemver(a, b) {
  for (var i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function readJsonFile(filePath) {
  var raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (ignored) {
    return null;
  }
  try {
    var parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch (ignored) {
    // Corrupt JSON is treated as absent.
  }
  return null;
}

// ── the pointer (step 2) ────────────────────────────────────────────────────────────────────────────
function readPointer(appRoot) {
  var obj = readJsonFile(path.join(appRoot, "current.json"));
  if (obj === null) return null;
  if (obj.schema !== 1) return null;
  if (typeof obj.version !== "string" || obj.version === "") return null;
  if (typeof obj.entry !== "string" || obj.entry === "") return null;
  return { version: obj.version, entry: obj.entry };
}

// ── fallback: the newest versions/<v> dir with a readable package.json + valid semver (step 2) ──────
function scanNewestVersion(appRoot) {
  var versionsDir = path.join(appRoot, "versions");
  var entries;
  try {
    entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  } catch (ignored) {
    return null;
  }
  var best = null;
  for (var i = 0; i < entries.length; i++) {
    if (!entries[i].isDirectory()) continue;
    var dir = path.join(versionsDir, entries[i].name);
    var pkg = readJsonFile(path.join(dir, "package.json"));
    if (pkg === null) continue;
    var semver = parseSemver(pkg.version);
    if (semver === null) continue;
    if (best === null || compareSemver(semver, best.semver) > 0) {
      best = { dir: dir, semver: semver, pkg: pkg };
    }
  }
  return best;
}

// The boot target: the absolute entry to import + the version dir to read engines from. Pointer first,
// fallback second. null ⇒ nothing valid on disk (banner A).
function resolveTarget(appRoot) {
  var pointer = readPointer(appRoot);
  if (pointer !== null) {
    return {
      entryAbs: path.resolve(appRoot, pointer.entry),
      versionDir: path.join(appRoot, "versions", pointer.version),
    };
  }
  var fallback = scanNewestVersion(appRoot);
  if (fallback === null) return null;
  var main =
    typeof fallback.pkg.main === "string" && fallback.pkg.main !== "" ? fallback.pkg.main : "cli.js";
  return { entryAbs: path.resolve(fallback.dir, main), versionDir: fallback.dir };
}

// ── node engines check (step 3) ─────────────────────────────────────────────────────────────────────
// Minimal parse: the first integer in engines.node is the required MAJOR (covers ">=20", "^20", "20",
// ">=20.0.0"). Absent / no package.json / no digits ⇒ null ⇒ the check is skipped (never blocks).
function requiredNodeMajor(versionDir) {
  var pkg = readJsonFile(path.join(versionDir, "package.json"));
  if (pkg === null) return null;
  var engines = pkg.engines;
  if (engines === null || typeof engines !== "object") return null;
  if (typeof engines.node !== "string") return null;
  var m = engines.node.match(/(\d+)/);
  return m === null ? null : Number(m[1]);
}
function runningNodeMajor() {
  var m = String(process.versions.node).match(/^(\d+)/);
  return m === null ? null : Number(m[1]);
}

// ── launch ──────────────────────────────────────────────────────────────────────────────────────────
var appRoot = path.dirname(url.fileURLToPath(import.meta.url));

var target = resolveTarget(appRoot);
if (target === null) {
  bannerInstallationBroken(null);
  process.exit(1);
}

var required = requiredNodeMajor(target.versionDir);
if (required !== null) {
  var current = runningNodeMajor();
  if (current !== null && current < required) {
    bannerNodeTooOld(required, current);
    process.exit(1);
  }
}

try {
  // Same process, same argv, same env — the pointed version simply takes over. The bundle entry is
  // IMPORTED (not the node main module), so on Node 22.18+ import.meta.main is a defined false for
  // it and its "am I the CLI entry?" guard would never fire. This env marker tells the bundle it was
  // launched through the frozen wrapper so it starts the CLI anyway (see bin.ts). (No backticks in
  // this body — it lives inside String.raw and a backtick would terminate the template.)
  process.env.RU_CODE_WRAPPER_LAUNCH = "1";
  await import(url.pathToFileURL(target.entryAbs).href);
} catch (err) {
  bannerInstallationBroken(firstLine(err));
  process.exit(1);
}
`;

/**
 * Build the complete source of `<appRoot>/cli.js` (the frozen wrapper) with the brand params baked in as
 * JSON-stringified `const` literals at the very top, above the ESM body. Emitted verbatim by
 * prepare-release / the installer, and exercised by executing it with `node` against fixture layouts.
 */
export function makeWrapperSource(params: WrapperSourceParams): string {
  const header = [
    "// ru-code: FROZEN launcher — do not edit on disk; regenerate from wrapperSource.ts. See that file.",
    `const APP_NAME = ${JSON.stringify(params.appName)};`,
    `const APP_COMMAND = ${JSON.stringify(params.appCommand)};`,
    `const SUPPORT_URL = ${JSON.stringify(params.supportUrl)};`,
  ].join("\n");
  return `${header}\n${WRAPPER_BODY}`;
}
