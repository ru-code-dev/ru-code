#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// Build a single universal tarball that:
//   - Installs via `npx <tarball-url>` (and via Nexus if published there)
//   - Installs via the corp `install.sh` script (extracted directly)
//
// Output: dist-bundle/ru-fork-<version>.tgz
//
// Inside the tarball:
//   package/
//     package.json            (slim, type:module, bin, bundledDependencies)
//     cli.js                  (= apps/server/dist/bin.mjs)
//     client/                 (= apps/server/dist/client)
//     node_modules/
//       node-pty/             (with prebuilds for every TARGETS entry)
//       msgpackr-extract/
//       @msgpackr-extract/    (one per-platform addon per TARGETS entry)
//       node-addon-api/, node-gyp-build-optional-packages/   (transitives)
//
// Usage: node scripts/prepare-release.ts [--skip-build]

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { APP_HOME_SLUG } from "@ru-fork/branding";

// =============================================================================
// CONFIG — comment out targets you don't ship
// =============================================================================

const TARGETS: ReadonlyArray<{ os: string; cpu: string }> = [
  { os: "linux", cpu: "x64" },
  { os: "linux", cpu: "arm64" },
  { os: "darwin", cpu: "x64" },
  { os: "darwin", cpu: "arm64" },
  { os: "win32", cpu: "x64" },
  { os: "win32", cpu: "arm64" }, // msgpackr-extract has no prebuild for this — JS fallback at runtime
];

const NODE_PTY_VERSION = "1.2.0-beta.12";
const MSGPACKR_EXTRACT_VERSION = "3.0.3";

// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const serverDir = path.join(repoRoot, "apps/server");
const distBundleDir = path.join(repoRoot, "dist-bundle");
const stagingDir = path.join(distBundleDir, "staging");
const packageDir = path.join(stagingDir, "package");

const skipBuild = process.argv.includes("--skip-build");

interface ServerPkg {
  name: string;
  version: string;
  license?: string;
  repository?: unknown;
  engines?: Record<string, string>;
}

const serverPkg: ServerPkg = JSON.parse(
  fs.readFileSync(path.join(serverDir, "package.json"), "utf8"),
);
const VERSION = serverPkg.version;
// Tarball name and bin key both derive from the branding slug — the same value
// the installer resolves as APP_BIN (preflight: APP_BIN = APP_HOME_SLUG). Keeps
// the produced `<slug>-<version>.tgz` matched to install's discovery across a
// rebrand, with no hand-editing.
const tarballPath = path.join(distBundleDir, `${APP_HOME_SLUG}-${VERSION}.tgz`);

function log(msg: string): void {
  process.stdout.write(`[prepare-release] ${msg}\n`);
}

function run(cmd: string, cwd?: string): void {
  log(`$ ${cmd}${cwd ? `   (cwd=${path.relative(repoRoot, cwd)})` : ""}`);
  execSync(cmd, { stdio: "inherit", cwd });
}

function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

function ensureBuild(): void {
  if (!skipBuild) {
    log("running `pnpm build`");
    run("pnpm build", repoRoot);
  } else {
    log("--skip-build set, assuming dist/ is fresh");
  }

  const required = [
    path.join(serverDir, "dist/bin.mjs"),
    path.join(serverDir, "dist/client/index.html"),
  ];
  const missing = required.filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    process.stderr.write("[prepare-release] Missing build artifacts:\n");
    for (const p of missing) process.stderr.write(`  - ${p}\n`);
    process.stderr.write("Run `pnpm build` (drop --skip-build) and retry.\n");
    process.exit(1);
  }
}

function stagePayload(): void {
  log(`staging payload at ${path.relative(repoRoot, packageDir)}`);
  rmrf(stagingDir);
  fs.mkdirSync(packageDir, { recursive: true });
  // Copy bin.mjs as cli.js, plus every sibling code-split chunk (tsdown emits
  // chunks like `open-XXXX.mjs` for dynamic imports — they sit next to bin.mjs
  // and are loaded at runtime via relative ESM imports).
  const distDir = path.join(serverDir, "dist");
  fs.copyFileSync(path.join(distDir, "bin.mjs"), path.join(packageDir, "cli.js"));
  for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === "bin.mjs") continue;
    if (!entry.name.endsWith(".mjs") && !entry.name.endsWith(".mjs.map")) continue;
    fs.copyFileSync(path.join(distDir, entry.name), path.join(packageDir, entry.name));
  }
  fs.cpSync(path.join(distDir, "client"), path.join(packageDir, "client"), {
    recursive: true,
  });
}

function platformAddonPackages(): Array<string> {
  // msgpackr-extract publishes a per-platform addon for each supported target.
  // win32-arm64 is intentionally absent upstream — runtime falls back to pure-JS.
  return TARGETS.filter((t) => !(t.os === "win32" && t.cpu === "arm64")).map(
    (t) => `@msgpackr-extract/msgpackr-extract-${t.os}-${t.cpu}`,
  );
}

function writeBootstrapPackageJson(): void {
  // Minimal package.json so `npm install` has something to install into.
  // We overwrite it with the slim publish-ready version after the install.
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "ru-fork-bundle-staging", version: VERSION, private: true }, null, 2) +
      "\n",
  );
}

function installNativeDeps(): void {
  // One npm install for everything. Each per-platform addon is named
  // explicitly, so npm installs it regardless of host os/cpu — `--force`
  // makes that contract robust across npm versions.
  const explicit = [
    `node-pty@${NODE_PTY_VERSION}`,
    `msgpackr-extract@${MSGPACKR_EXTRACT_VERSION}`,
    ...platformAddonPackages().map((p) => `${p}@${MSGPACKR_EXTRACT_VERSION}`),
  ];
  log(`installing ${explicit.length} native packages into staging node_modules`);
  run(
    [
      "npm install",
      "--no-save",
      "--no-package-lock",
      "--no-fund",
      "--no-audit",
      "--omit=dev",
      "--include=optional",
      "--force",
      ...explicit,
    ].join(" "),
    packageDir,
  );

  // npm sometimes drops a stale package-lock despite --no-package-lock; remove it.
  rmrf(path.join(packageDir, "package-lock.json"));

  // ru-fork: node_modules/.bin holds install-time CLI shims
  // (node-gyp-build-optional-packages, download-msgpackr-prebuilds) that
  // the bundled app never runs — node-pty require()s its .node directly
  // and msgpackr-extract loads via require("node-gyp-build-optional-packages")
  // (index.js), neither through .bin. They're Unix symlinks, and non-admin
  // git-bash can't recreate native symlinks: tar aborts mid-extraction on
  // them and client/ (which follows in archive order) never lands. Dropping
  // .bin makes the tarball symlink-free so install works without admin.
  rmrf(path.join(packageDir, "node_modules", ".bin"));
}

function writeSlimPackageJson(): void {
  const optionalDependencies: Record<string, string> = {};
  for (const pkg of platformAddonPackages()) {
    optionalDependencies[pkg] = MSGPACKR_EXTRACT_VERSION;
  }

  const bundled = [
    "node-pty",
    "msgpackr-extract",
    ...Object.keys(optionalDependencies),
    // Include transitive deps so install.sh users (no npm involved) get a
    // self-contained tree. They're already in node_modules from the install
    // step above; listing them in bundledDependencies makes npm/npx preserve
    // them too.
    "node-addon-api",
    "node-gyp-build-optional-packages",
  ];

  const pkg = {
    name: serverPkg.name,
    version: VERSION,
    license: serverPkg.license,
    repository: serverPkg.repository,
    type: "module",
    bin: { [APP_HOME_SLUG]: "./cli.js" },
    engines: serverPkg.engines,
    dependencies: {
      "node-pty": NODE_PTY_VERSION,
      "msgpackr-extract": MSGPACKR_EXTRACT_VERSION,
    },
    optionalDependencies,
    bundledDependencies: bundled,
  };

  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  log("wrote slim package.json");
}

function packTarball(): void {
  log(`packing -> ${path.relative(repoRoot, tarballPath)}`);
  rmrf(tarballPath);
  // Plain `tar czf` works on both GNU and BSD tar (macOS).
  run(`tar czf ${tarballPath} -C ${stagingDir} package`);
}

function summary(): void {
  const stat = fs.statSync(tarballPath);
  const sizeMb = (stat.size / 1024 / 1024).toFixed(2);
  const targetList = TARGETS.map((t) => `${t.os}-${t.cpu}`).join(", ");

  process.stdout.write("\n");
  process.stdout.write("=".repeat(64) + "\n");
  process.stdout.write(`  Bundle ready: ${path.relative(repoRoot, tarballPath)}\n`);
  process.stdout.write(`  Size:         ${sizeMb} MB\n`);
  process.stdout.write(`  Version:      ${VERSION}\n`);
  process.stdout.write(`  Targets:      ${targetList}\n`);
  process.stdout.write("=".repeat(64) + "\n\n");
  const testDir = "/tmp/ru-fork-test";
  process.stdout.write("Verify locally (npx path):\n");
  process.stdout.write(`  npx --yes file:${tarballPath} --version\n\n`);
  process.stdout.write("Verify locally (raw extract path) — single line, paste as-is:\n");
  process.stdout.write(
    `  rm -rf ${testDir} && mkdir ${testDir} && tar xzf ${tarballPath} -C ${testDir} && node ${testDir}/package/cli.js --version\n\n`,
  );
}

function main(): void {
  ensureBuild();
  fs.mkdirSync(distBundleDir, { recursive: true });
  stagePayload();
  writeBootstrapPackageJson();
  installNativeDeps();
  writeSlimPackageJson();
  packTarball();
  summary();
}

main();
