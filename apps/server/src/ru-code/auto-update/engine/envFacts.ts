// ru-code: environment facts for the auto-update engine (WRAPPER layout).
//
// · The VERSION is NEVER derived here — it is the build-baked
//   `apps/server/package.json` import the wiring passes in (the argv-sibling
//   package.json read was the old 0.0.0 bug; see the handoff doc).
// · The install LAYOUT is derived from the running entry script under the new
//   wrapper design (§1): an installed app is launched through the frozen
//   `<appRoot>/cli.js` wrapper, which sits BESIDE `current.json`. So the app is
//   updatable when either `RU_CODE_APP_ROOT` is set (→ appRoot = it, the e2e /
//   mock override) OR argv[1] basename is `cli.js` AND a `current.json` exists
//   next to it (→ appRoot = dirname(argv[1])). The `bin/` concept is gone; the
//   version dirs live under `<appRoot>/versions/<v>/`. A dev checkout matches
//   neither → `updatable: false` and install is refused with a clean error.
// · The `exists` probe is INJECTED (callers pass an fs.existsSync adapter) so the
//   detection stays a pure function of its inputs — trivially table-testable.
// · The PORT comes from the persisted server-runtime sentinel (written after
//   listen), read lazily and cached once seen — before that it reports 0 and the
//   client renders it as unknown.
// @effect-diagnostics preferSchemaOverJson:off

import type { UpdateEnvFactsWire } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import { UPDATES_TMP_RELATIVE, VERSIONS_DIRNAME } from "../apply/gc.ts";
import { POINTER_FILENAME } from "../apply/pointer.ts";

export interface UpdateLayout {
  /** True when the running entry matches the installed wrapper shape (or the env override is set). */
  readonly updatable: boolean;
  /** `<appRoot>` — the directory holding the wrapper + `current.json` + `versions/`; null on dev. */
  readonly appRoot: string | null;
  readonly entryJs: string;
}

/**
 * Detect the install layout from the running entry, purely. `exists` is injected
 * (the wiring passes an fs.existsSync adapter) so the existence probe of
 * `current.json` never makes this function do real I/O in a test.
 */
export function detectLayout(input: {
  readonly entry: string | undefined;
  readonly envAppRoot: string | undefined;
  readonly dirname: (p: string) => string;
  readonly basename: (p: string) => string;
  readonly join: (...parts: ReadonlyArray<string>) => string;
  readonly exists: (p: string) => boolean;
}): UpdateLayout {
  const { entry, envAppRoot, dirname, basename, join, exists } = input;
  const entryJs = entry ?? "";
  if (envAppRoot !== undefined && envAppRoot.trim().length > 0) {
    return { updatable: true, appRoot: envAppRoot, entryJs };
  }
  if (entry === undefined) return { updatable: false, appRoot: null, entryJs };
  const appRoot = dirname(entry);
  const isWrapper = basename(entry) === "cli.js" && exists(join(appRoot, POINTER_FILENAME));
  return isWrapper
    ? { updatable: true, appRoot, entryJs }
    : { updatable: false, appRoot: null, entryJs };
}

/** Pure defensive parse of the sentinel body. */
function parseSentinel(text: string): { port: number; address: string } | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const port = typeof record.port === "number" ? record.port : null;
    if (port === null) return null;
    const host = typeof record.host === "string" ? record.host : "127.0.0.1";
    return { port, address: `${host}:${port}` };
  } catch {
    return null;
  }
}

/** Read {host, port, origin} from the persisted server-runtime sentinel, defensively. */
function readSentinel(
  sentinelPath: string,
): Effect.Effect<{ port: number; address: string } | null, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(sentinelPath).pipe(Effect.orElseSucceed(() => ""));
    if (text === "") return null;
    return parseSentinel(text);
  });
}

/**
 * Can this process actually write EVERYWHERE an install writes? A system-wide install
 * (`--install-dir /opt/…` laid down by an admin) is a perfectly valid wrapper layout that a normal
 * user simply cannot update — better stated up front than discovered halfway through a download.
 *
 * Probes the appRoot itself AND the two subtrees the install run touches — the `updates/tmp`
 * workspace and `versions/` — because they can be owned by someone else while the root is
 * writable (a previous run under sudo is enough). A root-only probe passed that machine and the
 * failure then surfaced mid-install as a generic "not a valid release". The subdirs are created if
 * absent (they are the canonical layout, so materialising them at boot changes nothing); any
 * failure to create or write means "no".
 */
export function probeAppRootWritable(
  appRoot: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const probeDirs = [
      appRoot,
      path.join(appRoot, UPDATES_TMP_RELATIVE),
      path.join(appRoot, VERSIONS_DIRNAME),
    ];
    for (const dir of probeDirs) {
      const made = yield* fs.makeDirectory(dir, { recursive: true }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!made) return false;
      const probe = path.join(dir, ".write-probe");
      const wrote = yield* fs.writeFileString(probe, "").pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      yield* fs.remove(probe).pipe(Effect.orElseSucceed(() => undefined));
      if (!wrote) return false;
    }
    return true;
  });
}

/**
 * A facts reader: static layout facts + lazily-cached port/address from the
 * sentinel. `pid` is the live process. `installDir` is the appRoot when updatable,
 * else the running entry's directory (a dev checkout has no appRoot). `canApply`
 * combines the layout verdict with the write probe the wiring performed at boot.
 */
export function makeFactsReader(input: {
  readonly layout: UpdateLayout;
  readonly sentinelPath: string;
  /** Boot-time result of {@link probeAppRootWritable}; irrelevant when the layout is not updatable. */
  readonly appRootWritable: boolean;
}): Effect.Effect<
  Effect.Effect<UpdateEnvFactsWire, never, FileSystem.FileSystem>,
  never,
  Path.Path
> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const entryDir = input.layout.entryJs === "" ? "" : path.dirname(input.layout.entryJs);
    const installDir = input.layout.appRoot ?? entryDir;
    const blockReason: UpdateEnvFactsWire["blockReason"] = !input.layout.updatable
      ? "layout"
      : input.appRootWritable
        ? null
        : "read-only";
    const cached = yield* Ref.make<{ port: number; address: string } | null>(null);
    // Deliberate factory: the OUTER gen resolves Path and creates the cached Ref ONCE; the inner
    // Effect IS the reader, run again on every `yield* factsReader`. Flattening it — which is what
    // the suggestion asks for — would run the factory once and freeze the port and the address.
    // @effect-diagnostics-next-line returnEffectInGen:off - see above
    return Effect.gen(function* () {
      const seen = yield* Ref.get(cached);
      const live = seen ?? (yield* readSentinel(input.sentinelPath));
      if (seen === null && live !== null) yield* Ref.set(cached, live);
      return {
        installDir,
        entryJs: input.layout.entryJs,
        pid: process.pid,
        port: live?.port ?? 0,
        address: live?.address ?? "",
        canApply: blockReason === null,
        blockReason,
      };
    });
  });
}
