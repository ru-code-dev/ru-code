// ru-code: E2E HARNESS — release artifacts and the installed layout.
//
// Turns the working tree into the things a real user would have: a built server bundle, the real
// web client, a shipping-shaped release BUNDLE (frozen wrapper + pointer + `versions/<v>/payload`)
// and its tarball. Any feature that needs "the app as actually installed" starts here instead of
// faking a layout.
//
// Two properties are load-bearing and easy to lose:
//   · FRESHNESS — `ensureServerBundle` rebuilds when the bundle is older than ANY file under
//     apps/server/src. Without it a "green" run can be exercising last week's code.
//   · REALITY — the wrapper and the per-file checksums come from the SAME modules
//     `prepare-release` uses, so the tree under test is byte-shaped like a shipped release.
//
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  WRAPPER_PACKAGE_FILENAME,
  wrapperPackageSource,
} from "../../../apps/server/src/ru-code/auto-update/wrapper/installLayout.ts";
import { makeWrapperSource } from "../../../apps/server/src/ru-code/auto-update/wrapper/wrapperSource.ts";
import { writeChecksumsManifest } from "../../../scripts/ru-code/releaseManifest.ts";

import {
  assert,
  AssertionError,
  DIST_BUNDLE,
  log,
  mkTemp,
  REPO_ROOT,
  SERVER_DIST,
  WEB_DIST,
} from "./primitives.ts";

/**
 * The two versions every installed-app suite moves between: the one a sandbox is installed at, and
 * the newer one it is offered. Fixed strings on purpose — a spec that reads "1.0.0 → 2.0.0" is
 * instantly legible, and every fixture, pointer assertion and tarball name derives from these.
 */
export const VERSION_A = "1.0.0";
export const VERSION_B = "2.0.0";

/**
 * The identity baked into the frozen wrapper of a test bundle. Product branding, not feature
 * state — every suite wants the same values, which is why it lives here rather than in a feature.
 */
export const WRAPPER_PARAMS = {
  appName: "Ru Code",
  appCommand: "ru-code",
  supportUrl: "",
} as const;

// ── payload / layout assembly ────────────────────────────────────────────────────────────────
export interface Prepared {
  readonly basePayloadDir: string; // cli.js + code-split chunks (version-agnostic)
  readonly sharedNodeModules: string; // native N-API packages, symlinked into every appRoot
  /** The built web client (SPA + sw.js) copied into every version payload, or null (headless fast path). */
  readonly clientDir: string | null;
  readonly cleanTarball: Buffer;
  readonly cleanSha: string;
  readonly fileCorruptTarball: Buffer;
  readonly fileCorruptSha: string;
}

export const sha256 = (bytes: Buffer): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Tar `dir`'s CONTENTS at the archive root (`-C dir .`), gzip — matches fetchVersion's extract. */
export function tarDir(dir: string): Buffer {
  const out = NodePath.join(NodeOS.tmpdir(), `au-tar-${NodeCrypto.randomUUID()}.tgz`);
  NodeChildProcess.execFileSync("tar", ["-czf", out, "-C", dir, "."], { stdio: "ignore" });
  const bytes = NodeFS.readFileSync(out);
  NodeFS.rmSync(out, { force: true });
  return bytes;
}

/** Write cli.js + chunks + slim package.json(version) + optional client/ + __checksums.json into `destDir`. */
export function assemblePayload(
  basePayloadDir: string,
  destDir: string,
  version: string,
  clientDir: string | null = null,
): void {
  NodeFS.mkdirSync(destDir, { recursive: true });
  for (const name of NodeFS.readdirSync(basePayloadDir)) {
    NodeFS.copyFileSync(NodePath.join(basePayloadDir, name), NodePath.join(destDir, name));
  }
  NodeFS.writeFileSync(
    NodePath.join(destDir, "package.json"),
    JSON.stringify({ name: "t3", version, type: "module", engines: { node: ">=20" } }, null, 2) +
      "\n",
  );
  if (clientDir !== null) {
    // The REAL built SPA + sw.js — the installed server resolves its static dir as
    // `<dirname of cli.js>/client` (config.ts resolveStaticDir), i.e. versions/<v>/client.
    NodeFS.cpSync(clientDir, NodePath.join(destDir, "client"), { recursive: true });
  }
  writeChecksumsManifest(destDir); // the REAL per-file checksums helper prepare-release uses (recurses into client/)
}

/**
 * A shipping-shaped release BUNDLE at `bundleRoot`: the payload under `versions/<version>/` plus
 * the launcher pair at the root — the same tree `prepare-release` packs and the installer unpacks.
 * The updater must take only the version dir out of it, so the decoy wrapper at the root matters.
 */
export function assembleBundle(
  basePayloadDir: string,
  bundleRoot: string,
  version: string,
  clientDir: string | null = null,
): void {
  assemblePayload(
    basePayloadDir,
    NodePath.join(bundleRoot, "versions", version),
    version,
    clientDir,
  );
  NodeFS.writeFileSync(NodePath.join(bundleRoot, "cli.js"), makeWrapperSource(WRAPPER_PARAMS));
  // Beside the wrapper, exactly as a shipped bundle carries it.
  NodeFS.writeFileSync(NodePath.join(bundleRoot, WRAPPER_PACKAGE_FILENAME), wrapperPackageSource());
  NodeFS.writeFileSync(
    NodePath.join(bundleRoot, "current.json"),
    JSON.stringify({ schema: 1, version, entry: `versions/${version}/cli.js` }, null, 2) + "\n",
  );
}

/**
 * Newest mtime under `dir`, skipping node_modules. Used to tell a bundle that merely EXISTS from
 * one that actually contains the code in the working tree.
 */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(full));
      continue;
    }
    if (!/\.(ts|tsx|json)$/.test(entry.name)) continue;
    newest = Math.max(newest, NodeFS.statSync(full).mtimeMs);
  }
  return newest;
}

/**
 * Build the fat server bundle when it is missing, stale, or lacks a marker the caller requires.
 *
 * `seamMarker` is how a FEATURE says "this bundle is only usable to me if it carries my test seam"
 * (the auto-update suites pass their trigger-route marker). Omit it and only freshness is checked —
 * which is what a feature with no seams of its own wants.
 */
export function ensureServerBundle(options: { readonly seamMarker?: string } = {}): void {
  const binPath = NodePath.join(SERVER_DIST, "bin.mjs");
  const seamMarker = options.seamMarker;
  const hasSeam =
    NodeFS.existsSync(binPath) &&
    (seamMarker === undefined || NodeFS.readFileSync(binPath, "utf8").includes(seamMarker));
  // A bundle with the seams can still be STALE — every run of this suite must exercise the code in
  // the working tree, not whatever was packed last week. Comparing mtimes is what makes "green"
  // mean something after a source change.
  // …and a FRESH bundle can still be the wrong KIND. `pnpm build` writes the same path in dev mode,
  // where `effect` (and friends) stay external and are resolved from the repo's node_modules. That
  // bundle runs fine in place and is useless here: the release layout carries only NATIVE modules,
  // so the installed app dies with `Cannot find package 'effect'` — after a green build, from a
  // bundle newer than every source. A release bundle inlines those imports, so a surviving bare
  // `from "effect…"` is the signal, and it costs one read of a file already being read.
  const isReleaseBundle =
    NodeFS.existsSync(binPath) &&
    !/from\s*"effect(\/[^"]*)?"/.test(NodeFS.readFileSync(binPath, "utf8"));
  const fresh =
    hasSeam &&
    isReleaseBundle &&
    NodeFS.statSync(binPath).mtimeMs >=
      newestSourceMtime(NodePath.join(REPO_ROOT, "apps/server/src"));
  if (!isReleaseBundle && NodeFS.existsSync(binPath)) {
    log(
      "[build] the bundle on disk is a DEV build (effect left external) — rebuilding as a release",
    );
  }
  if (fresh) {
    log(
      "[build] apps/server/dist/bin.mjs carries the seams and is newer than every source — skipping build",
    );
    return;
  }
  if (hasSeam) log("[build] the bundle is older than a source file — rebuilding");
  log("[build] rebuilding the fat server bundle (RU_CODE_RELEASE_BUNDLE=1 vp pack) …");
  NodeChildProcess.execSync("pnpm --filter t3 build:bundle", {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, RU_CODE_RELEASE_BUNDLE: "1" },
  });
  if (seamMarker !== undefined) {
    assert(
      NodeFS.readFileSync(binPath, "utf8").includes(seamMarker),
      `rebuilt bundle is missing the required seam marker ${seamMarker}`,
    );
  }
}

/**
 * Ensure the REAL built web client exists at apps/web/dist (index.html + sw.js + assets) and
 * return its path, rebuilding when it is missing OR older than any file under `apps/web/src`.
 *
 * The freshness half was missing, and it cost a real bug its detection: presence alone decided the
 * skip, so once anyone had ever built the client, every later browser run served whatever bundle
 * happened to be on disk. A fix to the app's own root component was invisible to the suite meant to
 * prove it — the spec failed while the code was correct, which is the more dangerous direction's
 * twin: a suite that stays GREEN over client code that no longer exists.
 *
 * Same rule as {@link ensureServerBundle}, and for the same reason: an artifact older than its
 * sources makes "green" mean nothing.
 */
export function ensureWebClient(): string {
  const indexHtml = NodePath.join(WEB_DIST, "index.html");
  const swJs = NodePath.join(WEB_DIST, "sw.js");
  const present = NodeFS.existsSync(indexHtml) && NodeFS.existsSync(swJs);
  const fresh =
    present &&
    NodeFS.statSync(indexHtml).mtimeMs >=
      newestSourceMtime(NodePath.join(REPO_ROOT, "apps/web/src"));
  if (fresh) {
    log("[build] apps/web/dist is newer than every web source — skipping web build");
    return WEB_DIST;
  }
  if (present) log("[build] the web client is older than a source file — rebuilding");
  log("[build] building the web client (pnpm --filter @t3tools/web build) …");
  NodeChildProcess.execSync("pnpm --filter @t3tools/web build", {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  assert(NodeFS.existsSync(indexHtml), "web build produced no index.html");
  assert(NodeFS.existsSync(swJs), "web build produced no sw.js");
  return WEB_DIST;
}

/** Locate the natives inside an extracted bundle root: `<root>/node_modules` or `<root>/versions/<v>/node_modules`. */
function findNodeModules(bundleRoot: string): string | null {
  const atRoot = NodePath.join(bundleRoot, "node_modules");
  if (NodeFS.existsSync(atRoot)) return atRoot;
  const versionsDir = NodePath.join(bundleRoot, "versions");
  if (!NodeFS.existsSync(versionsDir)) return null;
  for (const version of NodeFS.readdirSync(versionsDir)) {
    const candidate = NodePath.join(versionsDir, version, "node_modules");
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return null;
}

export function newestTarball(): string {
  if (!NodeFS.existsSync(DIST_BUNDLE)) {
    throw new AssertionError(
      `no dist-bundle/ — run \`pnpm prepare-release\` first (need the native node_modules).`,
    );
  }
  const tgz = NodeFS.readdirSync(DIST_BUNDLE)
    .filter((n) => n.endsWith(".tgz"))
    .map((n) => NodePath.join(DIST_BUNDLE, n))
    .sort((a, b) => NodeFS.statSync(b).mtimeMs - NodeFS.statSync(a).mtimeMs)[0];
  if (tgz === undefined) {
    throw new AssertionError(`dist-bundle/ has no .tgz — run \`pnpm prepare-release\` first.`);
  }
  return tgz;
}

/**
 * Build the shared artifacts: the base server payload, the shared native node_modules (from the
 * existing release tarball), the optional real web client, and the version-B tarballs (clean +
 * inner-file-corrupt). `withClient` (default false) is the ONLY behavioural knob: off keeps the
 * headless suite's tiny client-less payloads; on carries the real SPA + sw.js for the browser spec.
 */
export function prepareArtifacts(options: {
  /** The version the assembled release bundle claims. Explicit: the harness owns no version scheme. */
  readonly version: string;
  /** Off keeps the payload client-less and tiny; on carries the REAL SPA + sw.js for browser specs. */
  readonly withClient?: boolean;
  /** Forwarded to {@link ensureServerBundle} — a marker the feature's seams must have compiled in. */
  readonly seamMarker?: string;
}): Prepared {
  ensureServerBundle(options.seamMarker === undefined ? {} : { seamMarker: options.seamMarker });
  const clientDir = options.withClient === true ? ensureWebClient() : null;
  const version = options.version;

  const cache = mkTemp("ru-au-livecycle-cache-");

  // 1) base payload = fresh cli.js + code-split chunks (no .map, no client).
  const basePayloadDir = NodePath.join(cache, "base-payload");
  NodeFS.mkdirSync(basePayloadDir, { recursive: true });
  for (const name of NodeFS.readdirSync(SERVER_DIST)) {
    if (!name.endsWith(".mjs")) continue; // excludes .mjs.map
    NodeFS.copyFileSync(
      NodePath.join(SERVER_DIST, name),
      NodePath.join(basePayloadDir, name === "bin.mjs" ? "cli.js" : name),
    );
  }
  assert(
    NodeFS.existsSync(NodePath.join(basePayloadDir, "cli.js")),
    "base payload is missing cli.js",
  );

  // 2) native node_modules from the existing release tarball (documented step-0 fallback).
  const extractDir = NodePath.join(cache, "tarball-extract");
  NodeFS.mkdirSync(extractDir, { recursive: true });
  NodeChildProcess.execFileSync("tar", ["-xzf", newestTarball(), "-C", extractDir], {
    stdio: "ignore",
  });
  // The natives live inside the bundle's version payload (`package/versions/<v>/node_modules`);
  // a tarball produced before the layout change carries them at `package/node_modules`.
  const foundNodeModules = findNodeModules(NodePath.join(extractDir, "package"));
  if (foundNodeModules === null) throw new AssertionError("release tarball has no node_modules");
  const sharedNodeModules: string = foundNodeModules;

  // 3) version-B clean BUNDLE (wrapper + pointer + versions/<B>/payload) → tarball + sha.
  const bundleB = NodePath.join(cache, "bundle-B");
  assembleBundle(basePayloadDir, bundleB, version, clientDir);
  const cleanTarball = tarDir(bundleB);
  const cleanSha = sha256(cleanTarball);

  // 4) version-B file-corrupt tarball: flip a byte in a chunk AFTER __checksums.json is written,
  //    then re-tar (archive sha recomputed → archive check passes, per-file check fails).
  const bundleBad = NodePath.join(cache, "bundle-B-filecorrupt");
  assembleBundle(basePayloadDir, bundleBad, version, clientDir);
  const payloadBad = NodePath.join(bundleBad, "versions", version);
  const chunk = NodeFS.readdirSync(payloadBad).find((n) => n.endsWith(".mjs") && n !== "cli.js");
  assert(chunk !== undefined, "no code-split chunk to corrupt for the file-integrity case");
  const chunkPath = NodePath.join(payloadBad, chunk as string);
  const chunkBytes = NodeFS.readFileSync(chunkPath);
  chunkBytes[Math.floor(chunkBytes.length / 2)] ^= 0xff; // flip a byte, leaving __checksums.json stale
  NodeFS.writeFileSync(chunkPath, chunkBytes);
  const fileCorruptTarball = tarDir(bundleBad);
  const fileCorruptSha = sha256(fileCorruptTarball);

  log(
    `[build] artifacts ready — cleanSha ${cleanSha.slice(0, 12)}…, payload ${(cleanTarball.length / 1024).toFixed(0)} KiB` +
      (clientDir !== null ? " (with client/)" : ""),
  );
  return {
    basePayloadDir,
    sharedNodeModules,
    clientDir,
    cleanTarball,
    cleanSha,
    fileCorruptTarball,
    fileCorruptSha,
  };
}

export interface Layout {
  readonly appRoot: string;
  readonly baseDir: string;
}
/** Real install layout: versions/<version> + symlinked node_modules + frozen wrapper + pointer. */
export function buildLayout(prepared: Prepared, version: string): Layout {
  const appRoot = mkTemp("ru-au-app-");
  const baseDir = mkTemp("ru-au-base-");
  // Identical to what unpacking a release bundle leaves behind, plus the shared natives symlink
  // (node resolves them by walking up from versions/<v>/cli.js).
  assembleBundle(prepared.basePayloadDir, appRoot, version, prepared.clientDir);
  NodeFS.symlinkSync(prepared.sharedNodeModules, NodePath.join(appRoot, "node_modules"), "dir");
  return { appRoot, baseDir };
}
