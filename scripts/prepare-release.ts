#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// ru-code: build a single self-sufficient tarball the installer copies onto a
// client machine verbatim — no `npm install`, no network, `node cli.js` just
// runs.
//
// Output: dist-bundle/<APP_COMMAND>-<version>.tgz
//
// ru-code: the tarball IS the installed `bin/` directory, byte for byte — the installer unpacks it
// and is done, and the in-app updater takes ONLY `versions/<version>/` out of the same artifact.
// One artifact, two consumers, zero layout logic on either side:
//   package/                    → becomes <appRoot>/bin/
//     cli.js                    the FROZEN wrapper (wrapperSource.ts) — reads current.json, imports
//                               the pointed entry; replaced only by an install, never by an update
//     current.json              the pointer → versions/<version>/cli.js (appRoot-RELATIVE)
//     preflight.mjs             install-time only (the installer runs it out of the extract dir)
//     versions/<version>/
//       package.json            slim: type:module, bin -> cli.js, engines (the wrapper's node gate)
//       cli.js                  (= apps/server/dist/bin.mjs — the FAT, self-contained bundle)
//       *.mjs                   sibling code-split chunks emitted next to bin.mjs
//       client/                 (= apps/server/dist/client — the built web app)
//       node_modules/           ONLY the native N-API packages + their prebuilds/loaders
//       __checksums.json        per-file integrity map of THIS version payload
//
// How the node_modules stays tiny: the release build sets RU_CODE_RELEASE_BUNDLE=1
// so `vp pack` inlines EVERY JavaScript dependency (effect, the provider SDKs,
// shiki, react-dom, …) into cli.js and externalizes only the packages that load a
// platform `.node` (they cannot be bundled) plus the Bun runtime builtins. This
// script then installs just those natives — with prebuilds for every target — so
// the shipped tree is ~a dozen dirs instead of the full dependency closure.
//
// Dropped on purpose: the Claude provider's per-platform binaries (ru-code drives
// qwen) and the Bun packages (@effect/platform-bun, @effect/sql-sqlite-bun — the
// installed CLI runs under Node).
//
// Usage: node scripts/prepare-release.ts [--skip-build]

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { APP_COMMAND, releaseTarballName } from "@ru-code/branding";

import { buildInstaller } from "./build-installer.ts";
// ru-code: auto-update release-artifact emission (manifest.json + changelog gate + changelog copy)
// + the in-tarball per-file checksums manifest + the release's required Node range.
import {
  CHECKSUMS_FILENAME,
  deriveMinNode,
  emitReleaseArtifacts,
  readChangelog,
  resolveChangelogEntry,
  writeChecksumsManifest,
} from "./ru-code/releaseManifest.ts";

// =============================================================================
// CONFIG — native packages + the platform targets they ship prebuilds for.
// =============================================================================

interface Target {
  readonly os: "linux" | "darwin" | "win32";
  readonly cpu: "x64" | "arm64";
}

// win32-arm64 is intentionally dropped: it's the heaviest arch (~6 MB gzip'd,
// mostly node-pty's 12 MB conpty binaries) for a niche target, and Windows-on-ARM
// can run the x64 build under emulation. Every other target — including
// linux-arm64 (servers / this build host) and darwin-arm64 (Apple Silicon) — ships.
const TARGETS: ReadonlyArray<Target> = [
  { os: "linux", cpu: "x64" },
  { os: "linux", cpu: "arm64" },
  { os: "darwin", cpu: "x64" },
  { os: "darwin", cpu: "arm64" },
  { os: "win32", cpu: "x64" },
];

// node-pty 1.2 betas ship in-package prebuilds for every target (no gyp build);
// the repo declares ^1.1.0 for dev, but the tarball pins the prebuilt beta.
const NODE_PTY_VERSION = "1.2.0-beta.14";
const FFF_NODE_VERSION = "0.9.4";
const FFI_RS_VERSION = "1.3.2";
const MSGPACKR_EXTRACT_VERSION = "3.0.4";
const BUFFERUTIL_VERSION = "4.1.0";
const UTF8_VALIDATE_VERSION = "6.0.6";

const libc = (t: Target): string => (t.os === "linux" ? "-gnu" : "");
const fffBin = (t: Target): string => `@ff-labs/fff-bin-${t.os}-${t.cpu}${libc(t)}`;
const ffiBin = (t: Target): string =>
  `@yuuang/ffi-rs-${t.os}-${t.cpu}${t.os === "win32" ? "-msvc" : t.os === "linux" ? "-gnu" : ""}`;
const msgpackrBin = (t: Target): string => `@msgpackr-extract/msgpackr-extract-${t.os}-${t.cpu}`;
// msgpackr-extract publishes no win32-arm64 addon — msgpackr falls back to pure JS there.
const msgpackrTargets = TARGETS.filter((t) => !(t.os === "win32" && t.cpu === "arm64"));

// Every package name (+ version) npm installs into the tarball's node_modules.
const nativeInstallSpecs: ReadonlyArray<string> = [
  `node-pty@${NODE_PTY_VERSION}`,
  `@ff-labs/fff-node@${FFF_NODE_VERSION}`,
  ...TARGETS.map((t) => `${fffBin(t)}@${FFF_NODE_VERSION}`),
  `ffi-rs@${FFI_RS_VERSION}`,
  ...TARGETS.map((t) => `${ffiBin(t)}@${FFI_RS_VERSION}`),
  `msgpackr-extract@${MSGPACKR_EXTRACT_VERSION}`,
  ...msgpackrTargets.map((t) => `${msgpackrBin(t)}@${MSGPACKR_EXTRACT_VERSION}`),
  `bufferutil@${BUFFERUTIL_VERSION}`,
  `utf-8-validate@${UTF8_VALIDATE_VERSION}`,
];

// =============================================================================

const scriptPath = NodeURL.fileURLToPath(import.meta.url);
const repoRoot = NodePath.resolve(NodePath.dirname(scriptPath), "..");
const serverDir = NodePath.join(repoRoot, "apps/server");
const distBundleDir = NodePath.join(repoRoot, "dist-bundle");
const stagingDir = NodePath.join(distBundleDir, "staging");
/** The bundle root — becomes the installed `bin/` verbatim. */
const packageDir = NodePath.join(stagingDir, "package");

const skipBuild = process.argv.includes("--skip-build");

interface ServerPkg {
  name: string;
  version: string;
  license?: string;
  repository?: unknown;
  engines?: Record<string, string>;
}

const serverPkg: ServerPkg = JSON.parse(
  NodeFS.readFileSync(NodePath.join(serverDir, "package.json"), "utf8"),
);
const VERSION = serverPkg.version;

// ru-code: the install layout is defined by the APP, not by this script — ask it for the names
// (`scripts/emitBundleLayout.ts paths`) instead of hardcoding "versions" / "cli.js" here, so the
// bundle, the installer and the in-app updater can never drift apart.
const layoutCli = NodePath.join(serverDir, "scripts/emitBundleLayout.ts");
interface LayoutNames {
  readonly wrapper: string;
  readonly pointer: string;
  readonly versionsDir: string;
  readonly entry: string;
}
const layout: LayoutNames = JSON.parse(
  NodeChildProcess.execFileSync("node", [layoutCli, "paths"], { encoding: "utf8" }),
) as LayoutNames;

/** The version payload — everything the app actually runs, and the ONLY part an update copies. */
const payloadDir = NodePath.join(packageDir, layout.versionsDir, VERSION);
// ru-code: the ONE shared naming convention both update channels derive from — never a manifest field.
const tarballPath = NodePath.join(distBundleDir, releaseTarballName(VERSION));

function log(msg: string): void {
  process.stdout.write(`[prepare-release] ${msg}\n`);
}

function run(cmd: string, cwd?: string, env?: NodeJS.ProcessEnv): void {
  log(`$ ${cmd}${cwd ? `   (cwd=${NodePath.relative(repoRoot, cwd)})` : ""}`);
  NodeChildProcess.execSync(cmd, { stdio: "inherit", cwd, env: env ?? process.env });
}

// ---------------------------------------------------------------------------
// SAFETY: every recursive delete resolves strictly inside dist-bundle/ or throws.
// Makes it impossible to rm -rf the repo, a worktree, or a home dir.
// ---------------------------------------------------------------------------
const distBundleFence = NodePath.resolve(distBundleDir) + NodePath.sep;

function assertInsideDistBundle(target: string): string {
  const resolved = NodePath.resolve(target);
  const isFenced =
    resolved === NodePath.resolve(distBundleDir) || resolved.startsWith(distBundleFence);
  if (!isFenced) {
    throw new Error(
      `[prepare-release] SAFETY: refusing to delete a path outside dist-bundle/: ${resolved}`,
    );
  }
  const forbidden = new Set(
    [repoRoot, NodePath.parse(resolved).root, process.env.HOME, process.env.USERPROFILE]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map((p) => NodePath.resolve(p)),
  );
  if (forbidden.has(resolved)) {
    throw new Error(`[prepare-release] SAFETY: refusing to delete a protected path: ${resolved}`);
  }
  return resolved;
}

function rmrf(target: string): void {
  NodeFS.rmSync(assertInsideDistBundle(target), { recursive: true, force: true });
}

// Build the FAT self-contained bundle: RU_CODE_RELEASE_BUNDLE=1 makes vp pack
// inline every JS dep into cli.js (see apps/server/vite.config.ts).
function ensureBuild(): void {
  if (!skipBuild) {
    log("running `pnpm build` (RU_CODE_RELEASE_BUNDLE=1 → self-contained cli.js)");
    run("pnpm build", repoRoot, { ...process.env, RU_CODE_RELEASE_BUNDLE: "1" });
  } else {
    log("--skip-build set, assuming apps/server/dist is a fresh RELEASE build");
  }
  const required = [
    NodePath.join(serverDir, "dist/bin.mjs"),
    NodePath.join(serverDir, "dist/client/index.html"),
  ];
  const missing = required.filter((p) => !NodeFS.existsSync(p));
  if (missing.length > 0) {
    process.stderr.write("[prepare-release] Missing build artifacts:\n");
    for (const p of missing) process.stderr.write(`  - ${p}\n`);
    process.exit(1);
  }
}

// ru-code: assemble the standalone `install` bash script from its parts (single source of
// truth for brand/config values). The drift-guard test keeps the committed copy fresh too;
// rebuilding here guarantees the shipped bundle carries the exact assembled artifact.
function buildInstallerScript(): void {
  log("building install (from ru-code/installer/parts)");
  const content = buildInstaller();
  NodeFS.writeFileSync(NodePath.join(repoRoot, "install"), content, { mode: 0o755 });
  NodeFS.chmodSync(NodePath.join(repoRoot, "install"), 0o755);
  log("assembled install at repo root");
}

// Build the standalone install-time preflight. It ships INSIDE the bundle (staged into package/
// by stagePayload), so the installer extracts it with the archive and runs it — no loose file to
// download, no separate distribution artifact. OS temp may be write-blocked, so the installer
// extracts into the clone dir; the bundled preflight rides along.
function buildPreflight(): void {
  log("building preflight.mjs");
  run("pnpm build:preflight", repoRoot);
  const built = NodePath.join(serverDir, "dist/preflight.mjs");
  if (!NodeFS.existsSync(built)) {
    process.stderr.write(`[prepare-release] preflight bundle not found at ${built}\n`);
    process.exit(1);
  }
}

// versions/<v>/ = cli.js + sibling chunks + client/ (node_modules added next); preflight.mjs is
// install-time and stays at the bundle ROOT, beside the wrapper.
function stagePayload(): void {
  log(`staging payload at ${NodePath.relative(repoRoot, payloadDir)}`);
  rmrf(stagingDir);
  NodeFS.mkdirSync(payloadDir, { recursive: true });

  const distDir = NodePath.join(serverDir, "dist");
  NodeFS.copyFileSync(NodePath.join(distDir, "bin.mjs"), NodePath.join(payloadDir, layout.entry));
  for (const entry of NodeFS.readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "bin.mjs") continue;
    if (!entry.name.endsWith(".mjs") && !entry.name.endsWith(".mjs.map")) continue;
    NodeFS.copyFileSync(NodePath.join(distDir, entry.name), NodePath.join(payloadDir, entry.name));
  }
  // Bundle the install-time preflight INSIDE the archive (explicit — not reliant on the .mjs loop).
  // It lives at the bundle root: the installer runs it from the extract dir before anything is
  // copied, and it is NOT part of any version payload.
  NodeFS.copyFileSync(
    NodePath.join(distDir, "preflight.mjs"),
    NodePath.join(packageDir, "preflight.mjs"),
  );
  NodeFS.cpSync(NodePath.join(distDir, "client"), NodePath.join(payloadDir, "client"), {
    recursive: true,
  });
}

// ru-code: the two files that make the extracted tree a LAUNCHABLE install — the frozen wrapper and
// the pointer at it — written by the APP's own emitter, so a fresh install and an in-app update
// produce byte-identical structures. The pointer entry is appRoot-RELATIVE by construction: the
// bundle must never carry a build-machine path.
function emitLayout(): void {
  log(`emitting ${layout.wrapper} + ${layout.pointer}`);
  run(`node "${layoutCli}" write "${packageDir}" "${VERSION}"`);
}

// Install ONLY the natives (+ every-platform addons) into the package. Each
// per-platform addon is named explicitly so npm installs it regardless of the
// host os/cpu; --ignore-scripts skips all native compilation (the packages ship
// prebuilds, resolved at require-time by node-gyp-build); --force keeps that
// cross-platform install robust across npm versions.
function installNatives(): void {
  NodeFS.writeFileSync(
    NodePath.join(payloadDir, "package.json"),
    JSON.stringify({ name: `${APP_COMMAND}-bundle-staging`, version: VERSION, private: true }) +
      "\n",
  );
  log(`installing ${nativeInstallSpecs.length} native packages (all platforms)`);
  run(
    [
      "npm install",
      "--no-save",
      "--no-package-lock",
      "--no-fund",
      "--no-audit",
      "--omit=dev",
      "--include=optional",
      "--ignore-scripts",
      "--force",
      ...nativeInstallSpecs,
    ].join(" "),
    payloadDir,
  );
  rmrf(NodePath.join(payloadDir, "package-lock.json"));
  // .bin holds Unix-symlink CLI shims the app never runs; dropping them keeps the
  // tarball symlink-free (non-admin Windows git-bash can't extract symlinks).
  const binShims = NodePath.join(payloadDir, "node_modules", ".bin");
  if (NodeFS.existsSync(binShims)) rmrf(binShims);
  pruneInPackagePrebuilds();
}

// Trim everything that isn't one of our TARGETS:
//  (a) per-platform ADDON packages npm auto-pulled for the build host as optional
//      deps of fff-node/ffi-rs (e.g. the host's @ff-labs/fff-bin-linux-arm64-gnu),
//  (b) the in-package `prebuilds/<os>-<cpu>` dirs of node-pty / bufferutil /
//      utf-8-validate (single packages that ship every arch), plus node-pty's
//      vendored win-arch conpty binaries.
function pruneInPackagePrebuilds(): void {
  const nm = NodePath.join(payloadDir, "node_modules");

  // (a) addon packages not in TARGETS.
  const allowedAddons = new Set<string>([
    ...TARGETS.map(fffBin),
    ...TARGETS.map(ffiBin),
    ...msgpackrTargets.map(msgpackrBin),
  ]);
  for (const [scope, base] of [
    ["@ff-labs", "fff-bin-"],
    ["@yuuang", "ffi-rs-"],
    ["@msgpackr-extract", "msgpackr-extract-"],
  ] as const) {
    const scopeDir = NodePath.join(nm, scope);
    if (!NodeFS.existsSync(scopeDir)) continue;
    for (const name of NodeFS.readdirSync(scopeDir)) {
      if (!name.startsWith(base)) continue; // leave non-bin packages (e.g. fff-node lives elsewhere)
      if (!allowedAddons.has(`${scope}/${name}`)) rmrf(NodePath.join(scopeDir, name));
    }
  }

  // (b) in-package prebuild dirs not in TARGETS.
  const keep = new Set(TARGETS.map((t) => `${t.os}-${t.cpu}`));
  const keepWin = new Set(TARGETS.filter((t) => t.os === "win32").map((t) => t.cpu));
  for (const pkg of ["node-pty", "bufferutil", "utf-8-validate"]) {
    const prebuilds = NodePath.join(payloadDir, "node_modules", pkg, "prebuilds");
    if (!NodeFS.existsSync(prebuilds)) continue;
    for (const dir of NodeFS.readdirSync(prebuilds)) {
      if (!keep.has(dir)) rmrf(NodePath.join(prebuilds, dir));
    }
  }
  // node-pty vendors OpenConsole.exe per Windows arch under third_party/conpty/*.
  const conpty = NodePath.join(payloadDir, "node_modules", "node-pty", "third_party", "conpty");
  if (NodeFS.existsSync(conpty)) {
    for (const ver of NodeFS.readdirSync(conpty)) {
      const verDir = NodePath.join(conpty, ver);
      if (!NodeFS.statSync(verDir).isDirectory()) continue;
      for (const winArch of NodeFS.readdirSync(verDir)) {
        // dirs look like win10-x64 / win10-arm64
        const cpu = winArch.replace(/^win\d*-/, "");
        if (!keepWin.has(cpu as Target["cpu"])) rmrf(NodePath.join(verDir, winArch));
      }
    }
  }
}

// Prove the shipped node_modules actually carries a prebuild for every target,
// per native. Essentials (node-pty / fff / ffi) MUST cover all targets; the
// optional accelerators may have gaps that degrade to pure JS — reported, not fatal.
function validateCoverage(): void {
  const nm = NodePath.join(payloadDir, "node_modules");
  const has = (rel: string): boolean => NodeFS.existsSync(NodePath.join(nm, rel));
  // node-pty / bufferutil / utf-8-validate ship in-package prebuilds/<plat>-<cpu>/.
  const inPkgPrebuild = (pkg: string, t: Target): boolean =>
    NodeFS.existsSync(NodePath.join(nm, pkg, "prebuilds", `${t.os}-${t.cpu}`));

  interface Row {
    label: string;
    essential: boolean;
    covered: (t: Target) => boolean;
    targets: ReadonlyArray<Target>;
  }
  const rows: ReadonlyArray<Row> = [
    {
      label: "node-pty",
      essential: true,
      targets: TARGETS,
      covered: (t) => inPkgPrebuild("node-pty", t),
    },
    {
      label: "@ff-labs/fff-node",
      essential: true,
      targets: TARGETS,
      covered: (t) => has(fffBin(t)),
    },
    { label: "ffi-rs", essential: true, targets: TARGETS, covered: (t) => has(ffiBin(t)) },
    {
      label: "msgpackr-extract",
      essential: false,
      targets: msgpackrTargets,
      covered: (t) => has(msgpackrBin(t)),
    },
    {
      label: "bufferutil",
      essential: false,
      targets: TARGETS,
      covered: (t) => inPkgPrebuild("bufferutil", t),
    },
    {
      label: "utf-8-validate",
      essential: false,
      targets: TARGETS,
      covered: (t) => inPkgPrebuild("utf-8-validate", t),
    },
  ];

  const cell = (ok: boolean): string => (ok ? "ok " : "-- ");
  process.stdout.write("\n[prepare-release] prebuild coverage matrix\n");
  process.stdout.write(
    `  ${"package".padEnd(20)}${TARGETS.map((t) => `${t.os}-${t.cpu}`.padEnd(13)).join("")}\n`,
  );
  let essentialGap = false;
  for (const row of rows) {
    const cells = TARGETS.map((t) => {
      if (!row.targets.includes(t)) return "n/a".padEnd(13);
      const ok = row.covered(t);
      if (!ok && row.essential) essentialGap = true;
      return cell(ok).padEnd(13);
    });
    process.stdout.write(`  ${row.label.padEnd(20)}${cells.join("")}\n`);
  }
  process.stdout.write("  (essentials must be all-ok; accelerator gaps degrade to pure JS)\n\n");
  if (essentialGap) {
    process.stderr.write(
      "[prepare-release] FAIL: an essential native is missing a target prebuild.\n",
    );
    process.exit(1);
  }
}

function writeSlimPackageJson(): void {
  const optionalDependencies: Record<string, string> = {};
  for (const t of TARGETS) {
    optionalDependencies[fffBin(t)] = FFF_NODE_VERSION;
    optionalDependencies[ffiBin(t)] = FFI_RS_VERSION;
  }
  for (const t of msgpackrTargets) optionalDependencies[msgpackrBin(t)] = MSGPACKR_EXTRACT_VERSION;

  const pkg = {
    name: serverPkg.name,
    version: VERSION,
    license: serverPkg.license,
    repository: serverPkg.repository,
    type: "module",
    bin: { [APP_COMMAND]: "./cli.js" },
    engines: serverPkg.engines,
    dependencies: {
      "node-pty": NODE_PTY_VERSION,
      "@ff-labs/fff-node": FFF_NODE_VERSION,
      "ffi-rs": FFI_RS_VERSION,
      "msgpackr-extract": MSGPACKR_EXTRACT_VERSION,
      bufferutil: BUFFERUTIL_VERSION,
      "utf-8-validate": UTF8_VALIDATE_VERSION,
    },
    optionalDependencies,
    // ru-code: no `bundledDependencies`. It used to be built from `readdirSync(node_modules)`,
    // which yields SCOPE directories (`@ff-labs`, `@yuuang`) rather than package names — and it
    // did nothing either way: the archive is packed with raw `tar czf`, its root carries no
    // package.json, and both consumers (the installer and the updater) extract it directly. A
    // field that is wrong and inert is worse than no field, because the next reader has to prove
    // it does not matter.
  };
  NodeFS.writeFileSync(
    NodePath.join(payloadDir, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  );
  log("wrote slim package.json");
}

// ru-code: bake the per-file checksums manifest into the payload root BEFORE packing, so the
// tarball carries its own integrity map (the install run re-verifies every extracted file against
// it). Runs after the payload is fully staged (natives + slim package.json) — it hashes every file
// then present except itself.
function writeChecksums(): void {
  const manifest = writeChecksumsManifest(payloadDir);
  log(
    `wrote ${CHECKSUMS_FILENAME} (${Object.keys(manifest.files).length} files, ${manifest.algo}) into payload root`,
  );
}

function packTarball(): void {
  log(`packing -> ${NodePath.relative(repoRoot, tarballPath)}`);
  // ru-code: pack FIRST, into a temp name, and only then drop the previous bundles. Deleting up front
  // meant a `tar` failure left `dist-bundle/` with no .tgz at all — the new one never written and
  // the previous WORKING one already gone. The rename is the last step, so the directory only ever
  // holds a complete bundle.
  const pendingPath = `${tarballPath}.packing`;
  rmrf(pendingPath);
  // ru-code: `COPYFILE_DISABLE=1` stops bsdtar (the `tar` on macOS) from emitting AppleDouble
  // `._<name>` companion entries for any payload file that happens to carry an extended attribute —
  // quarantine or `com.apple.provenance` are enough. Those entries extract as REAL files inside
  // `versions/<v>/`, and since the per-file checksums are computed from the staging tree BEFORE
  // packing, the installing machine would find files the manifest cannot know about. Harmless bytes,
  // but the integrity gate is deliberately strict about unlisted files, so a byte-perfect release
  // built on a Mac would fail every install. Inert on Linux, where the variable means nothing.
  run(`COPYFILE_DISABLE=1 tar czf "${pendingPath}" -C "${stagingDir}" package`);
  // Single-bundle contract: the installer refuses a dist-bundle holding >1 .tgz. Remove EVERY prior
  // bundle (any version), not just the same-named one, so a version bump never leaves two behind.
  for (const name of NodeFS.readdirSync(distBundleDir)) {
    if (name.endsWith(".tgz")) rmrf(NodePath.join(distBundleDir, name));
  }
  NodeFS.renameSync(pendingPath, tarballPath);
}

function summary(): void {
  const stat = NodeFS.statSync(tarballPath);
  const sizeMb = (stat.size / 1024 / 1024).toFixed(2);
  const nmCount = NodeFS.readdirSync(NodePath.join(payloadDir, "node_modules")).filter(
    (n) => !n.startsWith("."),
  ).length;
  process.stdout.write("\n" + "=".repeat(64) + "\n");
  process.stdout.write(`  Bundle ready: ${NodePath.relative(repoRoot, tarballPath)}\n`);
  process.stdout.write(`  Size:         ${sizeMb} MB\n`);
  process.stdout.write(`  Version:      ${VERSION}\n`);
  process.stdout.write(
    `  node_modules: ${nmCount} packages (natives + prebuilds, all platforms)\n`,
  );
  // oxlint-disable-next-line t3code/no-global-process-runtime -- standalone release script, no Effect runtime
  process.stdout.write(`  Built on:     ${NodeOS.platform()}-${NodeOS.arch()}\n`);
  process.stdout.write("=".repeat(64) + "\n\n");
  const testDir = `/tmp/${APP_COMMAND}-test`;
  process.stdout.write("Verify locally (raw extract path) — single line, paste as-is:\n");
  process.stdout.write(
    `  rm -rf ${testDir} && mkdir ${testDir} && tar xzf ${tarballPath} -C ${testDir} && node ${testDir}/package/cli.js --version\n\n`,
  );
}

function main(): void {
  // ru-code: the changelog gate FIRST. It is input-only and costs milliseconds, but it used to run
  // inside `emitReleaseArtifacts` — after the build, after `packTarball` had deleted every prior
  // bundle and written the new tarball. Forget the entry for a version and the whole build ran,
  // then threw, leaving `dist-bundle/` holding the OLD manifest.json (old version, sha256 of a
  // file that no longer exists) beside the NEW .tgz. UPDATE_WEB_URL points at exactly that
  // directory and both channels derive the tarball name from `manifest.version`, so every client
  // then asked for a deleted file and got a 404: an aborted release silently poisoned the update
  // channel. Failing before anything is touched is the whole fix.
  resolveChangelogEntry(readChangelog(repoRoot), VERSION);
  log(`changelog entry for ${VERSION} ✓`);

  ensureBuild();
  buildInstallerScript();
  buildPreflight();
  NodeFS.mkdirSync(distBundleDir, { recursive: true });
  stagePayload();
  installNatives();
  validateCoverage();
  writeSlimPackageJson();
  // ru-code: bake __checksums.json into the VERSION payload before packing (§1.6 in-tarball
  // integrity) — it covers exactly what an update copies, and the updater re-verifies it there.
  writeChecksums();
  // ru-code: the wrapper + pointer that turn the payload into a launchable install.
  emitLayout();
  packTarball();
  // ru-code: emit manifest.json (schema v2: minNode from engines, no rollbackSafe, no address) +
  // copy changelog.json next to the tarball (fails if the version has no changelog entry). The
  // tarball needs no URL in the manifest: it is the manifest's sibling and its name comes from
  // `releaseTarballName`, which both channels use to derive it. `minNode` derives from engines.node.
  const signingKeyPath = NodePath.join(repoRoot, "ru-code/keys/release-signing-private.pem");
  const hasSigningKey = NodeFS.existsSync(signingKeyPath);
  if (!hasSigningKey) {
    log("WARNING: signing key not found — the manifest will be unsigned");
  }
  emitReleaseArtifacts({
    repoRoot,
    outputDir: distBundleDir,
    tarballPath,
    version: VERSION,
    minNode: deriveMinNode(serverPkg.engines?.node),
    signingKeyPath: hasSigningKey ? signingKeyPath : null,
    log,
  });
  summary();
}

main();
