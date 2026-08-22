// ru-code: editor availability, precomputed and cheap (seam: process/externalLauncher.ts
// `make`, switched by USE_NON_BLOCKIN_EDITORS_SCAN).
//
// Upstream resolves the installed-editor list INSIDE `server.getConfig` — the RPC the client's
// connection gate waits for (rpc/session.ts `ready`) under a 15s establishment timeout. The
// resolution walks PATH for every editor command, and on Windows probes every
// command × PATH-entry × PATHEXT × upper/lower-case combination with a separate `stat`; on a
// machine with a long PATH and slow filesystem calls that outlasts the timeout, so the client
// drops the socket, retries, and the scan restarts from zero — forever.
//
// Two independent changes here, both preserving the result exactly:
//
//   1. WHEN — the scan runs once in the background at service construction and callers read a
//      cached value, so no RPC ever waits for the filesystem. Before the first scan lands the
//      list is empty, which is already a legal value (`ServerConfig.availableEditors` is a
//      plain array and is empty on any machine without editors); it reaches clients through
//      the normal config-update stream once the scan completes.
//
//   2. HOW — instead of probing every candidate path, each PATH entry is listed ONCE and that
//      listing decides whether the entry can possibly hold the command. Only a name that
//      actually exists is then confirmed by upstream's own `isCommandAvailable`.
//
// The result is IDENTICAL to upstream by construction, not by re-implementation:
//   • no false positives — every "available" verdict is produced by upstream's
//     `isCommandAvailable` (same executable rules, same PATHEXT handling, same
//     directory/permission checks), just pointed at the single directory that matched;
//   • no false negatives — the listing filter is a strict superset of what upstream can
//     accept: upstream only ever accepts a path `<entry>/<candidate>`, and such a file must
//     appear in that entry's listing under a name matching one of the candidates
//     (case-insensitively on Windows, where the filesystem is case-insensitive).
//
// Everything below the filter is upstream's; this module only decides which directories are
// worth asking about.

import { USE_NON_BLOCKIN_EDITORS_SCAN } from "@ru-code/branding";
import { EDITORS, type EditorId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

/**
 * PATH/PATHEXT lookup environment. Mirrors externalLauncher's own
 * `CommandLookupEnvConfig` (module-private there) so the scan reads exactly the same
 * variables as the upstream resolution it replaces.
 */
const CommandLookupEnvConfig = Config.all({
  PATH: Config.string("PATH").pipe(Config.option),
  Path: Config.string("Path").pipe(Config.option),
  path: Config.string("path").pipe(Config.option),
  PATHEXT: Config.string("PATHEXT").pipe(Config.option),
}).pipe(
  Config.map((input) =>
    Object.fromEntries(
      Object.entries(input).flatMap(([key, value]) =>
        Option.match(value, {
          onNone: () => [],
          onSome: (resolved) => [[key, resolved]],
        }),
      ),
    ),
  ),
);

const readCommandLookupEnv = CommandLookupEnvConfig.pipe(
  Effect.orElseSucceed((): NodeJS.ProcessEnv => ({})),
);

const WINDOWS_PATH_EXTENSION_FALLBACK = [".COM", ".EXE", ".BAT", ".CMD"] as const;
const WINDOWS_PATH_DELIMITER = ";";
const POSIX_PATH_DELIMITER = ":";

/** Mirrors shell.ts `readEnvPath` — Windows env lookups are case-insensitive. */
function readEnvPath(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

/** Mirrors shell.ts `pathDelimiterForPlatform`. */
function pathDelimiterForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? WINDOWS_PATH_DELIMITER : POSIX_PATH_DELIMITER;
}

/** Mirrors shell.ts `stripWrappingQuotes`. */
function stripWrappingQuotes(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1)
    : value;
}

/** Mirrors shell.ts `resolveWindowsPathExtensions`. */
export function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  if (!rawValue) return [...WINDOWS_PATH_EXTENSION_FALLBACK];

  const parsed: string[] = [];
  for (const entry of rawValue.split(WINDOWS_PATH_DELIMITER)) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    parsed.push(trimmed.startsWith(".") ? trimmed.toUpperCase() : `.${trimmed.toUpperCase()}`);
  }
  return parsed.length > 0 ? Array.from(new Set(parsed)) : [...WINDOWS_PATH_EXTENSION_FALLBACK];
}

/**
 * PATH entries in order, trimmed and unquoted exactly as shell.ts does, with duplicates
 * dropped — a directory listed twice can only produce the same verdict.
 */
export function resolvePathEntries(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  const pathValue = readEnvPath(env) ?? "";
  if (pathValue.length === 0) return [];

  const entries: string[] = [];
  const seen = new Set<string>();
  for (const rawEntry of pathValue.split(pathDelimiterForPlatform(platform))) {
    const entry = stripWrappingQuotes(rawEntry.trim());
    if (entry.length === 0) continue;
    const key = platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

/**
 * File names a directory listing must contain for `command` to possibly resolve there.
 * Mirrors the candidate construction in shell.ts `resolveCommandCandidates`, minus the
 * upper/lower-case duplication: Windows filesystems are case-insensitive, so the two spellings
 * always denote the same file and the comparison is done case-insensitively instead.
 */
export function candidateFileNames(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
  extname: (path: string) => string,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];

  const extension = extname(command);
  if (extension.length > 0 && windowsPathExtensions.includes(extension.toUpperCase())) {
    return [command];
  }
  return windowsPathExtensions.map((candidateExtension) => `${command}${candidateExtension}`);
}

/** The file-manager command per platform. Mirrors externalLauncher's own switch. */
export function fileManagerCommandForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}

/** Commands to try for an editor, in order. `commands: null` ⇒ the platform file manager. */
function commandsForEditor(
  editor: (typeof EDITORS)[number],
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  return editor.commands === null ? [fileManagerCommandForPlatform(platform)] : editor.commands;
}

/**
 * Confirm one command against ONE directory using upstream's own resolution, by handing it a
 * PATH containing just that directory. `isCommandAvailable` reads only PATH and PATHEXT, so
 * this is upstream's exact verdict for that directory.
 */
const isCommandAvailableIn = Effect.fn("ru-code.availableEditors.confirm")(function* (
  command: string,
  directory: string,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  return yield* isCommandAvailable(command, {
    env: {
      PATH: directory,
      ...(env.PATHEXT === undefined ? {} : { PATHEXT: env.PATHEXT }),
    },
  });
});

/** A directory's entry names, empty when it cannot be listed (missing, a file, unreadable). */
const listDirectoryNames = Effect.fn("ru-code.availableEditors.list")(function* (
  directory: string,
  platform: NodeJS.Platform,
): Effect.fn.Return<ReadonlySet<string>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  return new Set(entries.map((entry) => (platform === "win32" ? entry.toLowerCase() : entry)));
});

/**
 * Scan for installed editors in `env`'s PATH. Same result as upstream's
 * `buildAvailableEditors(platform, env)`, in the same order (EDITORS order), with one directory
 * listing per PATH entry instead of a probe per command × entry × extension × case.
 */
export const scanAvailableEditorsIn = Effect.fn("ru-code.availableEditors.scanIn")(function* (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<EditorId>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const available = new Set<EditorId>();

  // Commands that already carry a path separator are never looked up on PATH by upstream;
  // resolve them directly (the built-in list has none — this keeps the two paths equivalent
  // for any future entry that does).
  const pending: { readonly id: EditorId; readonly commands: ReadonlyArray<string> }[] = [];
  for (const editor of EDITORS) {
    const commands = commandsForEditor(editor, platform);
    const rooted = commands.filter((command) => command.includes("/") || command.includes("\\"));
    const relative = commands.filter(
      (command) => !command.includes("/") && !command.includes("\\"),
    );
    for (const command of rooted) {
      if (yield* isCommandAvailable(command, { env })) {
        available.add(editor.id);
        break;
      }
    }
    if (!available.has(editor.id) && relative.length > 0) {
      pending.push({ id: editor.id, commands: relative });
    }
  }

  for (const directory of resolvePathEntries(env, platform)) {
    if (pending.every((entry) => available.has(entry.id))) break;

    const names = yield* listDirectoryNames(directory, platform);
    if (names.size === 0) continue;

    for (const entry of pending) {
      if (available.has(entry.id)) continue;
      for (const command of entry.commands) {
        const candidates = candidateFileNames(
          command,
          platform,
          windowsPathExtensions,
          path.extname,
        );
        const mayExist = candidates.some((candidate) =>
          names.has(platform === "win32" ? candidate.toLowerCase() : candidate),
        );
        if (!mayExist) continue;
        if (yield* isCommandAvailableIn(command, directory, env)) {
          available.add(entry.id);
          break;
        }
      }
    }
  }

  return EDITORS.filter((editor) => available.has(editor.id)).map((editor) => editor.id);
});

/** {@link scanAvailableEditorsIn} for the host platform and the host PATH/PATHEXT. */
export const scanAvailableEditors = Effect.fn("ru-code.availableEditors.scan")(
  function* (): Effect.fn.Return<
    ReadonlyArray<EditorId>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const platform = yield* HostProcessPlatform;
    const env = yield* readCommandLookupEnv;
    return yield* scanAvailableEditorsIn(platform, env);
  },
);

export interface AvailableEditorsResolver {
  /** The current list. Never performs I/O when the background scan is enabled. */
  readonly resolve: Effect.Effect<ReadonlyArray<EditorId>>;
  /** Re-run the scan and publish the result. Unused in production; exercised by tests. */
  readonly refresh: Effect.Effect<void>;
}

export interface AvailableEditorsOptions {
  /** Upstream's inline resolution, used verbatim when the switch is off. */
  readonly legacy: () => Effect.Effect<ReadonlyArray<EditorId>>;
  /** Test seam; defaults to {@link USE_NON_BLOCKIN_EDITORS_SCAN}. */
  readonly enabled?: boolean;
  /** Test seam; defaults to {@link scanAvailableEditors} (host platform, host PATH). */
  readonly scan?: Effect.Effect<ReadonlyArray<EditorId>, never, FileSystem.FileSystem | Path.Path>;
}

/**
 * Build the editor-list resolver. `USE_NON_BLOCKIN_EDITORS_SCAN === false` returns upstream's
 * inline resolution untouched — no cache, no background fiber, no behaviour change at all.
 */
export const makeAvailableEditorsCompat = Effect.fn("ru-code.availableEditors.make")(function* (
  options: AvailableEditorsOptions,
): Effect.fn.Return<AvailableEditorsResolver, never, FileSystem.FileSystem | Path.Path> {
  if (!(options.enabled ?? USE_NON_BLOCKIN_EDITORS_SCAN)) {
    const legacy = options.legacy();
    return { resolve: legacy, refresh: Effect.asVoid(legacy) };
  }

  // Capture the services once so the returned effects carry no requirements of their own.
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cache = yield* Ref.make<ReadonlyArray<EditorId>>([]);
  const refresh = (options.scan ?? scanAvailableEditors()).pipe(
    Effect.flatMap((editors) => Ref.set(cache, editors)),
    Effect.ignoreCause({ log: true }),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  // Background: the list is a startup fact, and no request may wait for the filesystem.
  yield* Effect.forkDetach(refresh);

  return { resolve: Ref.get(cache), refresh };
});
