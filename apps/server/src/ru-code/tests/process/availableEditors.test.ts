// ru-code: proof that the background editor scan (USE_NON_BLOCKIN_EDITORS_SCAN) returns exactly
// what upstream's inline scan returns, on every platform, with far fewer filesystem calls.
//
// The oracle is not a re-implementation: it is upstream's own algorithm
// (process/externalLauncher.ts `buildAvailableEditors` + `resolveAvailableCommand`) expressed
// over upstream's own exported primitive `isCommandAvailable`. Every case runs BOTH scans
// against the SAME filesystem, platform and environment and asserts identical output.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { USE_NON_BLOCKIN_EDITORS_SCAN } from "@ru-code/branding";
import { EDITORS, type EditorId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { CommandResolutionCache, isCommandAvailable } from "@t3tools/shared/shell";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  candidateFileNames,
  fileManagerCommandForPlatform,
  makeAvailableEditorsCompat,
  resolvePathEntries,
  resolveWindowsPathExtensions,
  scanAvailableEditors,
  scanAvailableEditorsIn,
} from "../../process/availableEditors.ts";

// ==============================
// Upstream oracle
// ==============================

/**
 * Upstream's editor resolution, composed from upstream's own `isCommandAvailable`.
 * Mirrors `buildAvailableEditors` (externalLauncher.ts) one-for-one.
 */
const upstreamScanEditors = Effect.fn("upstreamScanEditors")(function* (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<EditorId>, never, FileSystem.FileSystem | Path.Path> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    if (editor.commands === null) {
      const command = fileManagerCommandForPlatform(platform);
      if (yield* isCommandAvailable(command, { env })) {
        available.push(editor.id);
      }
      continue;
    }

    for (const command of editor.commands) {
      if (yield* isCommandAvailable(command, { env })) {
        available.push(editor.id);
        break;
      }
    }
  }

  return available;
});

// ==============================
// Fake filesystem (Windows semantics)
// ==============================

interface FakeEntry {
  readonly name: string;
  readonly type: "File" | "Directory";
}

type FakeTree = ReadonlyArray<readonly [string, ReadonlyArray<FakeEntry>]>;

interface OperationCounts {
  stat: number;
  readDirectory: number;
}

const fileInfo = (type: "File" | "Directory"): FileSystem.File.Info => ({
  type,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0o755,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(0),
  blksize: Option.none(),
  blocks: Option.none(),
});

const notFound = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: `${path} does not exist`,
  });

const file = (name: string): FakeEntry => ({ name, type: "File" });
const directory = (name: string): FakeEntry => ({ name, type: "Directory" });

/**
 * In-memory filesystem with Windows lookup semantics (case-insensitive names) and per-call
 * counters. Only `stat` and `readDirectory` are reachable from the code under test.
 */
function makeFakeFileSystem(tree: FakeTree, platform: NodeJS.Platform) {
  const counts: OperationCounts = { stat: 0, readDirectory: 0 };
  const normalize = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const directories = new Map(tree.map(([path, entries]) => [normalize(path), entries]));

  const fileSystem = FileSystem.makeNoop({
    stat: (path: string) => {
      counts.stat += 1;
      const separatorIndex = path.lastIndexOf("/");
      const parent = separatorIndex <= 0 ? "/" : path.slice(0, separatorIndex);
      const name = path.slice(separatorIndex + 1);
      const entries = directories.get(normalize(parent));
      const entry = entries?.find((candidate) => normalize(candidate.name) === normalize(name));
      return entry === undefined
        ? Effect.fail(notFound("stat", path))
        : Effect.succeed(fileInfo(entry.type));
    },
    readDirectory: (path: string) => {
      counts.readDirectory += 1;
      const entries = directories.get(normalize(path));
      return entries === undefined
        ? Effect.fail(notFound("readDirectory", path))
        : Effect.succeed(entries.map((entry) => entry.name));
    },
  });

  return { fileSystem, counts };
}

const totalOperations = (counts: OperationCounts): number => counts.stat + counts.readDirectory;

// ==============================
// Environment plumbing
// ==============================

interface LookupEnv {
  readonly PATH?: string;
  readonly PATHEXT?: string;
}

const provideFake = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  fileSystem: FileSystem.FileSystem,
  platform: NodeJS.Platform,
) =>
  effect.pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(HostProcessPlatform, platform),
    // ru-code: shell.ts's own doc comment invites this — the default cache is a single
    // process-wide map, which would otherwise leak an "available" verdict from one fake
    // filesystem/PATH combination into a later case that reuses the same PATH string.
    Effect.provideService(CommandResolutionCache, new Map()),
    Effect.provide(NodeServices.layer),
  );

/** Run both scans over one fake filesystem and return their results plus their call counts. */
const compareScans = Effect.fn("compareScans")(function* (input: {
  readonly tree: FakeTree;
  readonly platform: NodeJS.Platform;
  readonly env: LookupEnv;
}) {
  const fast = makeFakeFileSystem(input.tree, input.platform);
  const legacy = makeFakeFileSystem(input.tree, input.platform);

  const fastResult = yield* provideFake(
    scanAvailableEditorsIn(input.platform, { ...input.env }),
    fast.fileSystem,
    input.platform,
  );
  const legacyResult = yield* provideFake(
    upstreamScanEditors(input.platform, { ...input.env }),
    legacy.fileSystem,
    input.platform,
  );

  return {
    fastResult,
    legacyResult,
    fastCounts: fast.counts,
    legacyCounts: legacy.counts,
  };
});

// ==============================
// Windows equivalence sweep
// ==============================

interface WindowsCase {
  readonly name: string;
  readonly tree: FakeTree;
  readonly env: LookupEnv;
  readonly expected: ReadonlyArray<EditorId>;
}

const WINDOWS_CASES: ReadonlyArray<WindowsCase> = [
  {
    name: "resolves editors spread across PATH entries",
    tree: [
      ["/a", [file("explorer.exe"), file("notes.txt")]],
      ["/b", [file("code.exe")]],
      ["/c", [file("cursor.cmd")]],
    ],
    env: { PATH: "/a;/b;/c" },
    expected: ["cursor", "vscode", "file-manager"],
  },
  {
    name: "matches names case-insensitively, as Windows filesystems do",
    tree: [["/a", [file("CODE.EXE"), file("Cursor.Cmd")]]],
    env: { PATH: "/a" },
    expected: ["cursor", "vscode"],
  },
  {
    name: "rejects a directory that is named like an executable",
    tree: [["/a", [directory("code.exe")]]],
    env: { PATH: "/a" },
    expected: [],
  },
  {
    name: "skips PATH entries that cannot be listed",
    tree: [["/present", [file("code.exe")]]],
    env: { PATH: "/missing;/present;/also-missing" },
    expected: ["vscode"],
  },
  {
    name: "finds nothing when PATH is empty",
    tree: [["/a", [file("code.exe")]]],
    env: {},
    expected: [],
  },
  {
    name: "honours a custom PATHEXT",
    tree: [["/a", [file("code.exe"), file("cursor.bat")]]],
    env: { PATH: "/a", PATHEXT: ".BAT;.CMD" },
    expected: ["cursor"],
  },
  {
    name: "normalises PATHEXT entries written without a leading dot",
    tree: [["/a", [file("code.exe")]]],
    env: { PATH: "/a", PATHEXT: "EXE;cmd" },
    expected: ["vscode"],
  },
  {
    name: "ignores files whose extension is not executable",
    tree: [["/a", [file("code.txt"), file("cursor")]]],
    env: { PATH: "/a" },
    expected: [],
  },
  {
    name: "unwraps quoted and padded PATH entries",
    tree: [["/a b", [file("code.exe")]]],
    env: { PATH: '  "/a b"  ;  ' },
    expected: ["vscode"],
  },
  {
    name: "handles a PATH entry repeated several times",
    tree: [["/a", [file("code.exe")]]],
    env: { PATH: "/a;/a;/a" },
    expected: ["vscode"],
  },
  {
    name: "falls back to an editor's second command",
    tree: [["/a", [file("zeditor.exe")]]],
    env: { PATH: "/a" },
    expected: ["zed"],
  },
  {
    name: "prefers the first command when both are installed",
    tree: [["/a", [file("zed.exe"), file("zeditor.exe")]]],
    env: { PATH: "/a" },
    expected: ["zed"],
  },
  {
    name: "returns every editor in EDITORS order when all are installed",
    tree: [
      [
        "/all",
        EDITORS.flatMap((editor) =>
          (editor.commands ?? ["explorer"]).map((command) => file(`${command}.exe`)),
        ),
      ],
    ],
    env: { PATH: "/all" },
    expected: EDITORS.map((editor) => editor.id),
  },
  {
    name: "finds nothing when no PATH entry lists a known command",
    tree: [["/a", [file("git.exe"), file("node.exe"), directory("tools")]]],
    env: { PATH: "/a" },
    expected: [],
  },
];

describe("availableEditors (win32)", () => {
  for (const testCase of WINDOWS_CASES) {
    it.effect(`${testCase.name} — identical to the upstream scan`, () =>
      Effect.gen(function* () {
        const comparison = yield* compareScans({
          tree: testCase.tree,
          platform: "win32",
          env: testCase.env,
        });

        expect(comparison.fastResult).toStrictEqual(testCase.expected);
        expect(comparison.fastResult).toStrictEqual(comparison.legacyResult);
      }),
    );
  }

  it.effect("adds at most one directory listing per PATH entry, and usually far fewer", () =>
    Effect.gen(function* () {
      for (const testCase of WINDOWS_CASES) {
        const comparison = yield* compareScans({
          tree: testCase.tree,
          platform: "win32",
          env: testCase.env,
        });
        const listedDirectories = resolvePathEntries({ ...testCase.env }, "win32").length;

        // The listing is the only operation this scan adds; everything else it removes.
        expect(totalOperations(comparison.fastCounts)).toBeLessThanOrEqual(
          totalOperations(comparison.legacyCounts) + listedDirectories,
        );
        expect(comparison.fastCounts.readDirectory).toBeLessThanOrEqual(listedDirectories);
        expect(comparison.fastCounts.stat).toBeLessThanOrEqual(comparison.legacyCounts.stat);
      }
    }),
  );
});

// ==============================
// Cost on a realistic Windows machine
// ==============================

describe("availableEditors cost", () => {
  const LONG_PATH_DIRECTORIES = 40;
  const WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC";

  const longPathTree: FakeTree = [
    ...Array.from({ length: LONG_PATH_DIRECTORIES - 1 }, (_unused, index) => {
      const entry: readonly [string, ReadonlyArray<FakeEntry>] = [
        `/dir${index}`,
        [file("git.exe"), file("node.exe"), file("readme.md"), directory("bin")],
      ];
      return entry;
    }),
    [`/dir${LONG_PATH_DIRECTORIES - 1}`, [file("code.exe"), file("explorer.exe")]],
  ];

  const longPathEnv: LookupEnv = {
    PATH: longPathTree.map(([path]) => path).join(";"),
    PATHEXT: WINDOWS_PATHEXT,
  };

  it.effect("returns the same list with an order of magnitude fewer calls", () =>
    Effect.gen(function* () {
      const comparison = yield* compareScans({
        tree: longPathTree,
        platform: "win32",
        env: longPathEnv,
      });

      expect(comparison.fastResult).toStrictEqual(["vscode", "file-manager"]);
      expect(comparison.fastResult).toStrictEqual(comparison.legacyResult);

      const fast = totalOperations(comparison.fastCounts);
      const legacy = totalOperations(comparison.legacyCounts);

      // The upstream scan probes command × PATH entry × PATHEXT × case; this one lists each
      // PATH entry once and confirms only names that exist.
      expect(legacy).toBeGreaterThan(10_000);
      expect(fast).toBeLessThan(200);
      expect(fast * 50).toBeLessThan(legacy);
    }),
  );
});

// ==============================
// POSIX equivalence, against a real filesystem
// ==============================

const writeExecutable = Effect.fn("writeExecutable")(function* (
  directoryPath: string,
  name: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(directoryPath, name);
  yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n").pipe(Effect.orDie);
  yield* fileSystem.chmod(filePath, 0o755).pipe(Effect.orDie);
});

const writeNonExecutable = Effect.fn("writeNonExecutable")(function* (
  directoryPath: string,
  name: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(directoryPath, name);
  yield* fileSystem.writeFileString(filePath, "not executable\n").pipe(Effect.orDie);
  yield* fileSystem.chmod(filePath, 0o644).pipe(Effect.orDie);
});

const comparePosixScans = Effect.fn("comparePosixScans")(function* (input: {
  readonly platform: NodeJS.Platform;
  readonly pathValue: string;
}) {
  const env: NodeJS.ProcessEnv = { PATH: input.pathValue };
  const fastResult = yield* scanAvailableEditorsIn(input.platform, env).pipe(
    Effect.provideService(HostProcessPlatform, input.platform),
    Effect.provideService(CommandResolutionCache, new Map()),
  );
  const legacyResult = yield* upstreamScanEditors(input.platform, env).pipe(
    Effect.provideService(HostProcessPlatform, input.platform),
    Effect.provideService(CommandResolutionCache, new Map()),
  );

  return { fastResult, legacyResult };
});

it.layer(NodeServices.layer)("availableEditors (posix, real filesystem)", (it) => {
  describe("against a real temporary filesystem", () => {
    it.effect("matches the upstream scan for executables, non-executables and directories", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-editors-" });
        const binOne = path.join(root, "one");
        const binTwo = path.join(root, "two");
        yield* fileSystem.makeDirectory(binOne, { recursive: true }).pipe(Effect.orDie);
        yield* fileSystem.makeDirectory(binTwo, { recursive: true }).pipe(Effect.orDie);

        // installed
        yield* writeExecutable(binOne, "code");
        yield* writeExecutable(binTwo, "zeditor");
        yield* writeExecutable(binOne, "xdg-open");
        // present but not runnable
        yield* writeNonExecutable(binOne, "cursor");
        // a directory shadowing a command name
        yield* fileSystem.makeDirectory(path.join(binOne, "idea")).pipe(Effect.orDie);

        const comparison = yield* comparePosixScans({
          platform: "linux",
          pathValue: [binOne, binTwo, path.join(root, "missing")].join(":"),
        });

        expect(comparison.fastResult).toStrictEqual(["vscode", "zed", "file-manager"]);
        expect(comparison.fastResult).toStrictEqual(comparison.legacyResult);
      }).pipe(Effect.scoped),
    );

    it.effect("matches the upstream scan on darwin, including its file manager", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-editors-" });
        const bin = path.join(root, "bin");
        yield* fileSystem.makeDirectory(bin, { recursive: true }).pipe(Effect.orDie);

        yield* writeExecutable(bin, "open");
        yield* writeExecutable(bin, "webstorm");
        // the linux file manager must NOT count on darwin
        yield* writeExecutable(bin, "xdg-open");

        const comparison = yield* comparePosixScans({ platform: "darwin", pathValue: bin });

        expect(comparison.fastResult).toStrictEqual(["webstorm", "file-manager"]);
        expect(comparison.fastResult).toStrictEqual(comparison.legacyResult);
      }).pipe(Effect.scoped),
    );

    it.effect("matches the upstream scan when nothing is installed", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-editors-" });
        const bin = path.join(root, "bin");
        yield* fileSystem.makeDirectory(bin, { recursive: true }).pipe(Effect.orDie);
        yield* writeExecutable(bin, "git");

        const comparison = yield* comparePosixScans({ platform: "linux", pathValue: bin });

        expect(comparison.fastResult).toStrictEqual([]);
        expect(comparison.fastResult).toStrictEqual(comparison.legacyResult);
      }).pipe(Effect.scoped),
    );

    it.effect("is case sensitive on posix, like the platform itself", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-editors-" });
        const bin = path.join(root, "bin");
        yield* fileSystem.makeDirectory(bin, { recursive: true }).pipe(Effect.orDie);
        yield* writeExecutable(bin, "Code");

        const comparison = yield* comparePosixScans({ platform: "linux", pathValue: bin });

        expect(comparison.fastResult).toStrictEqual([]);
        expect(comparison.fastResult).toStrictEqual(comparison.legacyResult);
      }).pipe(Effect.scoped),
    );
  });
});

// ==============================
// The production wiring, on this machine
// ==============================

describe("availableEditors (host machine)", () => {
  it.effect("agrees with the upstream scan on the real PATH, read through effect Config", () =>
    Effect.gen(function* () {
      const hostEnv: NodeJS.ProcessEnv = {
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        ...(process.env.PATHEXT === undefined ? {} : { PATHEXT: process.env.PATHEXT }),
      };

      // scanAvailableEditors() resolves platform + PATH/PATHEXT exactly as production does.
      const platform = yield* HostProcessPlatform;
      const fastResult = yield* scanAvailableEditors();
      const legacyResult = yield* upstreamScanEditors(platform, hostEnv);

      expect(fastResult).toStrictEqual(legacyResult);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// ==============================
// Cache behaviour and the switch
// ==============================

describe("makeAvailableEditorsCompat", () => {
  const tree: FakeTree = [["/a", [file("code.exe")]]];

  it("defaults to the non-blocking scan", () => {
    expect(USE_NON_BLOCKIN_EDITORS_SCAN).toBe(true);
  });

  // Real clock: the background scan started at construction must be allowed to settle.
  it.live("serves a cached list without touching the filesystem", () =>
    Effect.gen(function* () {
      const fake = makeFakeFileSystem(tree, "win32");
      const resolver = yield* provideFake(
        Effect.gen(function* () {
          const resolver = yield* makeAvailableEditorsCompat({
            enabled: true,
            scan: scanAvailableEditorsIn("win32", { PATH: "/a" }),
            legacy: () => Effect.die("the legacy scan must not run when the switch is on"),
          });
          yield* resolver.refresh;
          return resolver;
        }),
        fake.fileSystem,
        "win32",
      );

      // Let the background scan started at construction settle before counting.
      yield* Effect.sleep("50 millis");
      const afterScan = { ...fake.counts };
      const first = yield* resolver.resolve;
      const second = yield* resolver.resolve;
      const third = yield* resolver.resolve;

      expect(first).toStrictEqual(["vscode"]);
      expect(second).toStrictEqual(first);
      expect(third).toStrictEqual(first);
      expect(fake.counts.stat).toBe(afterScan.stat);
      expect(fake.counts.readDirectory).toBe(afterScan.readDirectory);
    }),
  );

  it.effect("starts empty, which the config contract already allows", () =>
    Effect.gen(function* () {
      const fake = makeFakeFileSystem(tree, "win32");
      const editors = yield* provideFake(
        Effect.gen(function* () {
          const resolver = yield* makeAvailableEditorsCompat({
            enabled: true,
            // A scan that never completes: the resolver must answer anyway.
            scan: Effect.never,
            legacy: () => Effect.die("the legacy scan must not run when the switch is on"),
          });
          return yield* resolver.resolve;
        }),
        fake.fileSystem,
        "win32",
      );

      expect(editors).toStrictEqual([]);
      expect(totalOperations(fake.counts)).toBe(0);
    }),
  );

  it.effect("uses the upstream scan verbatim when the switch is off", () =>
    Effect.gen(function* () {
      const fake = makeFakeFileSystem(tree, "win32");
      const legacyList: ReadonlyArray<EditorId> = ["vscodium"];
      let legacyCalls = 0;

      const resolver = yield* provideFake(
        makeAvailableEditorsCompat({
          enabled: false,
          legacy: () =>
            Effect.sync(() => {
              legacyCalls += 1;
              return legacyList;
            }),
        }),
        fake.fileSystem,
        "win32",
      );

      const first = yield* resolver.resolve;
      const second = yield* resolver.resolve;

      expect(first).toStrictEqual(legacyList);
      expect(second).toStrictEqual(legacyList);
      // Called per request, exactly as upstream does — and no background scan ran.
      expect(legacyCalls).toBe(2);
      expect(totalOperations(fake.counts)).toBe(0);
    }),
  );
});

// ==============================
// Helpers mirrored from upstream
// ==============================

describe("path parsing helpers", () => {
  it("mirrors upstream PATHEXT parsing", () => {
    expect(resolveWindowsPathExtensions({})).toStrictEqual([".COM", ".EXE", ".BAT", ".CMD"]);
    expect(resolveWindowsPathExtensions({ PATHEXT: "" })).toStrictEqual([
      ".COM",
      ".EXE",
      ".BAT",
      ".CMD",
    ]);
    expect(resolveWindowsPathExtensions({ PATHEXT: "exe;.CMD" })).toStrictEqual([".EXE", ".CMD"]);
    expect(resolveWindowsPathExtensions({ PATHEXT: ".EXE;.exe; ;" })).toStrictEqual([".EXE"]);
  });

  it("mirrors upstream PATH splitting and drops repeats", () => {
    expect(resolvePathEntries({ PATH: '/a;"/b c";;/a' }, "win32")).toStrictEqual(["/a", "/b c"]);
    expect(resolvePathEntries({ PATH: "/a:/b:/a" }, "linux")).toStrictEqual(["/a", "/b"]);
    expect(resolvePathEntries({}, "linux")).toStrictEqual([]);
    expect(resolvePathEntries({ Path: "/a" }, "win32")).toStrictEqual(["/a"]);
  });

  it("derives the file names a directory must contain", () => {
    const extensions = [".EXE", ".CMD"];
    const extname = (value: string) => {
      const index = value.lastIndexOf(".");
      return index <= 0 ? "" : value.slice(index);
    };

    expect(candidateFileNames("code", "win32", extensions, extname)).toStrictEqual([
      "code.EXE",
      "code.CMD",
    ]);
    expect(candidateFileNames("code.exe", "win32", extensions, extname)).toStrictEqual([
      "code.exe",
    ]);
    expect(candidateFileNames("code.bar", "win32", extensions, extname)).toStrictEqual([
      "code.bar.EXE",
      "code.bar.CMD",
    ]);
    expect(candidateFileNames("code", "linux", [], extname)).toStrictEqual(["code"]);
  });

  it("mirrors upstream's file-manager command per platform", () => {
    expect(fileManagerCommandForPlatform("darwin")).toBe("open");
    expect(fileManagerCommandForPlatform("win32")).toBe("explorer");
    expect(fileManagerCommandForPlatform("linux")).toBe("xdg-open");
  });
});
