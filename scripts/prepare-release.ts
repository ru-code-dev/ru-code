#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// ru-code: build a single self-sufficient tarball the installer copies onto a
// client machine verbatim — no `npm install`, no network, `node cli.js` just
// runs.
//
// Output: dist-bundle/<APP_COMMAND>-<version>.tgz
//
// Inside the tarball:
//   package/
//     package.json   (slim: type:module, bin -> cli.js)
//     cli.js         (= apps/server/dist/bin.mjs — the FAT, self-contained bundle)
//     *.mjs          (sibling code-split chunks emitted next to bin.mjs)
//     client/        (= apps/server/dist/client — the built web app)
//     node_modules/  (ONLY the native N-API packages + their prebuilds/loaders)
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

import { APP_COMMAND } from "@ru-code/branding";

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
const tarballPath = NodePath.join(distBundleDir, `${APP_COMMAND}-${VERSION}.tgz`);

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

// Build the standalone install-time preflight and place it at the repo root,
// next to `install`, where the installer's BUNDLE_DIR lookup finds it.
function buildPreflight(): void {
  log("building preflight.mjs");
  run("pnpm build:preflight", repoRoot);
  const built = NodePath.join(serverDir, "dist/preflight.mjs");
  if (!NodeFS.existsSync(built)) {
    process.stderr.write(`[prepare-release] preflight bundle not found at ${built}\n`);
    process.exit(1);
  }
  NodeFS.copyFileSync(built, NodePath.join(repoRoot, "preflight.mjs"));
  log("placed preflight.mjs at repo root");
}

// package/ = cli.js + sibling chunks + client/ (node_modules added next).
function stagePayload(): void {
  log(`staging payload at ${NodePath.relative(repoRoot, packageDir)}`);
  rmrf(stagingDir);
  NodeFS.mkdirSync(packageDir, { recursive: true });

  const distDir = NodePath.join(serverDir, "dist");
  NodeFS.copyFileSync(NodePath.join(distDir, "bin.mjs"), NodePath.join(packageDir, "cli.js"));
  for (const entry of NodeFS.readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "bin.mjs") continue;
    if (!entry.name.endsWith(".mjs") && !entry.name.endsWith(".mjs.map")) continue;
    NodeFS.copyFileSync(NodePath.join(distDir, entry.name), NodePath.join(packageDir, entry.name));
  }
  NodeFS.cpSync(NodePath.join(distDir, "client"), NodePath.join(packageDir, "client"), {
    recursive: true,
  });
}

// Install ONLY the natives (+ every-platform addons) into the package. Each
// per-platform addon is named explicitly so npm installs it regardless of the
// host os/cpu; --ignore-scripts skips all native compilation (the packages ship
// prebuilds, resolved at require-time by node-gyp-build); --force keeps that
// cross-platform install robust across npm versions.
function installNatives(): void {
  NodeFS.writeFileSync(
    NodePath.join(packageDir, "package.json"),
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
    packageDir,
  );
  rmrf(NodePath.join(packageDir, "package-lock.json"));
  // .bin holds Unix-symlink CLI shims the app never runs; dropping them keeps the
  // tarball symlink-free (non-admin Windows git-bash can't extract symlinks).
  const binShims = NodePath.join(packageDir, "node_modules", ".bin");
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
  const nm = NodePath.join(packageDir, "node_modules");

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
    const prebuilds = NodePath.join(packageDir, "node_modules", pkg, "prebuilds");
    if (!NodeFS.existsSync(prebuilds)) continue;
    for (const dir of NodeFS.readdirSync(prebuilds)) {
      if (!keep.has(dir)) rmrf(NodePath.join(prebuilds, dir));
    }
  }
  // node-pty vendors OpenConsole.exe per Windows arch under third_party/conpty/*.
  const conpty = NodePath.join(packageDir, "node_modules", "node-pty", "third_party", "conpty");
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
  const nm = NodePath.join(packageDir, "node_modules");
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
    // Everything on disk is already resolved; bundledDependencies makes npm/npx
    // preserve the whole node_modules tree if the tarball is installed that way.
    bundledDependencies: NodeFS.readdirSync(NodePath.join(packageDir, "node_modules")).filter(
      (n) => !n.startsWith("."),
    ),
  };
  NodeFS.writeFileSync(
    NodePath.join(packageDir, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  );
  log("wrote slim package.json");
}

function packTarball(): void {
  log(`packing -> ${NodePath.relative(repoRoot, tarballPath)}`);
  if (NodeFS.existsSync(tarballPath)) rmrf(tarballPath);
  run(`tar czf "${tarballPath}" -C "${stagingDir}" package`);
}

function summary(): void {
  const stat = NodeFS.statSync(tarballPath);
  const sizeMb = (stat.size / 1024 / 1024).toFixed(2);
  const nmCount = NodeFS.readdirSync(NodePath.join(packageDir, "node_modules")).filter(
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
  ensureBuild();
  buildPreflight();
  NodeFS.mkdirSync(distBundleDir, { recursive: true });
  stagePayload();
  installNatives();
  validateCoverage();
  writeSlimPackageJson();
  packTarball();
  summary();
}

main();
