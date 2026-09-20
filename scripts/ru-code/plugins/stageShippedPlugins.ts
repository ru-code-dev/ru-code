#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - build tooling: runs before any Effect runtime exists.
//
// ru-code (V2-20): stage the SHIPPED plugin set into a destination folder.
//
// The shipped set is the list of plugins a release carries INSIDE its version payload
// (`versions/<v>/plugins/<id>`, a sibling of `client/`). This script is the one place that turns
// `ru-code/packaging/shipped-plugins.json` into that folder; it is called twice with the same code:
//
//   pnpm build          → apps/server/scripts/cli.ts, after `apps/web/dist` → `dist/client`
//                         (so `apps/server/dist/plugins` is a sibling of `dist/client` in dev,
//                          in the release payload AND in the desktop artifact, which copies the
//                          whole of `apps/server/dist`)
//   pnpm stage:plugins  → the same thing on its own, for the dev loop
//
// prepare-release then copies `apps/server/dist/plugins` into the payload beside `client`, before
// `__checksums.json` is written, so the shipped bytes are inside the integrity map rather than
// beside it.
//
// POSTURE — the release never fails for a plugin. Owner override to the S6 analysis (which
// recommended a hard fail): a listed path that is missing, is not a directory, carries no
// `plugin.json`, or carries one that does not decode is **logged and skipped**. A release with no
// shipped plugins is legal (a fork, a minimal build, a clone without the `ru-code-packages`
// symlink), and `prepare-release` does NOT add `dist/plugins` to its required-build list. The one
// thing that IS fatal is an unreadable/ill-shaped `shipped-plugins.json`, because that is the tool
// being broken rather than an input being absent. There is deliberately no staleness check and no
// `--build`: D9 / rule 7 fix the build order (packages first, then the app), and a release script
// that silently builds a package hides a packages-repo failure inside a 4-minute app build.
//
// COPY, NEVER SYMLINK. `scanPluginsDir` refuses any entry whose `realPath` leaves the plugins root
// (`apps/server/src/ru-code/plugins/scan.ts`), so a symlinked plugin folder is silently ignored at
// boot; and the release tarball must stay symlink-free (non-admin Windows git-bash cannot extract
// symlinks — see `prepare-release.ts:packTarball`). Hence `cpSync({ dereference: true })`.
//
// @module@module scripts/ru-code/plugins/stageShippedPlugins
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/** The committed list, relative to the app root. */
export const SHIPPED_PLUGINS_LIST_RELATIVE = "ru-code/packaging/shipped-plugins.json";

/** Where `pnpm build` stages the set — a sibling of `dist/client` in every world. */
export const SHIPPED_PLUGINS_DIST_RELATIVE = "apps/server/dist/plugins";

/** The manifest file that makes a folder a plugin. */
const PLUGIN_MANIFEST_FILENAME = "plugin.json";

/** What the SDK's `decodePluginManifest` gives back, narrowed to what staging reads. */
export interface StagedManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

/**
 * `decodePluginManifest` from `@smart-tools/plugin-sdk/contracts`, as this script uses it.
 *
 * Injected rather than imported so the staging logic is a pure function the unit test can drive —
 * and so the ONE awkward thing here (see {@link loadManifestDecoder}) stays in one place.
 */
export type ManifestDecoder = (
  input: unknown,
) =>
  | { readonly _tag: "Success"; readonly success: StagedManifest }
  | { readonly _tag: "Failure"; readonly failure: string };

/**
 * Load the SDK's real manifest decoder.
 *
 * WHY the exports-map dance instead of `import { decodePluginManifest } from
 * "@smart-tools/plugin-sdk/contracts"`. The SDK is a dependency of `apps/{web,server}` and
 * `packages/contracts` (pinned `0.4.0`, resolved through the untracked `ru-code-packages` link by
 * `.pnpmfile.cjs`); it is NOT a dependency of `@t3tools/scripts`, and pnpm's isolated
 * `node_modules` means a bare specifier from this file resolves to nothing. Adding the dependency
 * would mean editing `scripts/package.json` + the lockfile to buy one function. So the package is
 * located where it provably is — beside the app that pins it — and entered through its OWN
 * `exports` map rather than a guessed `dist/` path, so an SDK layout change surfaces here as a
 * clear failure instead of a wrong file.
 *
 * The alternative — hand-rolling the manifest checks in this script — was rejected: staging must
 * accept exactly what the loader will accept, and that is one schema, in the SDK.
 */
export async function loadManifestDecoder(appRoot: string): Promise<ManifestDecoder> {
  const packageDir = NodePath.join(appRoot, "apps/server/node_modules/@smart-tools/plugin-sdk");
  const manifestPath = NodePath.join(packageDir, "package.json");
  if (!NodeFS.existsSync(manifestPath)) {
    throw new Error(
      `[stage-plugins] the plugin SDK is not installed at ${packageDir} — run \`pnpm install\``,
    );
  }
  const packageJson: unknown = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  const subpath = readContractsSubpath(packageJson);
  if (subpath === undefined) {
    throw new Error(
      `[stage-plugins] ${manifestPath} declares no "./contracts" import condition — the SDK layout changed`,
    );
  }
  const entry = NodePath.resolve(NodeFS.realpathSync(packageDir), subpath);
  const module: unknown = await import(NodeURL.pathToFileURL(entry).href);
  const decode = (module as { readonly decodePluginManifest?: unknown }).decodePluginManifest;
  if (typeof decode !== "function") {
    throw new Error(`[stage-plugins] ${entry} does not export decodePluginManifest`);
  }
  return decode as ManifestDecoder;
}

function readContractsSubpath(packageJson: unknown): string | undefined {
  if (typeof packageJson !== "object" || packageJson === null) return undefined;
  const exports = (packageJson as { readonly exports?: unknown }).exports;
  if (typeof exports !== "object" || exports === null) return undefined;
  const contracts = (exports as Record<string, unknown>)["./contracts"];
  if (typeof contracts !== "object" || contracts === null) return undefined;
  const value = (contracts as Record<string, unknown>)["import"];
  return typeof value === "string" ? value : undefined;
}

/** One plugin that made it into the destination. */
export interface StagedPlugin {
  readonly id: string;
  readonly version: string;
  readonly bytes: number;
  /** The listed path, as written in `shipped-plugins.json`. */
  readonly source: string;
}

/** One listed path that did not. Never fatal. */
export interface SkippedPlugin {
  readonly source: string;
  readonly reason: string;
}

export interface StageResult {
  readonly bundled: ReadonlyArray<StagedPlugin>;
  readonly skipped: ReadonlyArray<SkippedPlugin>;
}

/**
 * Read the committed list.
 *
 * A MISSING file is an empty list (nothing to ship — legal). A file that exists but cannot be
 * parsed, or whose `plugins` is not an array of strings, THROWS: that is the tool's own input
 * being broken, and silently shipping nothing is exactly the failure mode this list exists to
 * prevent. Unknown keys (`_comment`) are ignored on purpose — JSON has no comments and the file
 * has to explain itself to whoever edits it next.
 */
export function readShippedPluginsList(listPath: string): ReadonlyArray<string> {
  if (!NodeFS.existsSync(listPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(NodeFS.readFileSync(listPath, "utf8"));
  } catch (cause) {
    throw new Error(
      `[stage-plugins] ${listPath} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`[stage-plugins] ${listPath} must be a JSON object with a "plugins" array`);
  }
  const plugins = (parsed as { readonly plugins?: unknown }).plugins;
  if (plugins === undefined) return [];
  if (!Array.isArray(plugins) || plugins.some((entry) => typeof entry !== "string")) {
    throw new Error(`[stage-plugins] ${listPath}: "plugins" must be an array of folder paths`);
  }
  return plugins as ReadonlyArray<string>;
}

/** Total size of every regular file under `dir`, following nothing (the copy is already flat). */
function directoryBytes(dir: string): number {
  let total = 0;
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const child = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directoryBytes(child);
      continue;
    }
    if (entry.isFile()) total += NodeFS.statSync(child).size;
  }
  return total;
}

/** `candidate` is `root` itself or lives beneath it — the loader's own containment rule. */
function isWithinRoot(root: string, candidate: string): boolean {
  return (
    candidate === root ||
    candidate.startsWith(root.endsWith(NodePath.sep) ? root : `${root}${NodePath.sep}`)
  );
}

/**
 * Copy every listed plugin folder into `destDir/<manifest id>`.
 *
 * The destination is CLEANED first: the shipped set is replaced wholesale by every build, exactly
 * as it is replaced wholesale by every install and update, so a plugin dropped from the list must
 * not survive in `dist/` and ride along into the next tarball.
 */
export function stageShippedPlugins(input: {
  readonly appRoot: string;
  readonly listPath: string;
  readonly destDir: string;
  readonly decode: ManifestDecoder;
  readonly log: (message: string) => void;
}): StageResult {
  const listed = readShippedPluginsList(input.listPath);
  const bundled: Array<StagedPlugin> = [];
  const skipped: Array<SkippedPlugin> = [];

  NodeFS.rmSync(input.destDir, { recursive: true, force: true });
  NodeFS.mkdirSync(input.destDir, { recursive: true });
  const destRoot = NodePath.resolve(input.destDir);

  const skip = (source: string, reason: string): void => {
    skipped.push({ source, reason });
    input.log(`SKIP ${source}: ${reason}`);
  };

  const seen = new Map<string, string>();
  for (const source of listed) {
    const dir = NodePath.resolve(input.appRoot, source);
    const stat = NodeFS.existsSync(dir) ? NodeFS.statSync(dir) : null;
    if (stat === null) {
      skip(source, `no such folder (${dir})`);
      continue;
    }
    if (!stat.isDirectory()) {
      skip(source, "not a directory");
      continue;
    }

    const manifestPath = NodePath.join(dir, PLUGIN_MANIFEST_FILENAME);
    if (!NodeFS.existsSync(manifestPath)) {
      skip(source, `no ${PLUGIN_MANIFEST_FILENAME} (is the package built?)`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
    } catch (cause) {
      skip(
        source,
        `${PLUGIN_MANIFEST_FILENAME} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      continue;
    }
    const decoded = input.decode(parsed);
    if (decoded._tag === "Failure") {
      skip(source, `${PLUGIN_MANIFEST_FILENAME} does not decode: ${decoded.failure}`);
      continue;
    }
    const manifest = decoded.success;

    // D8 at STAGING time. The loader refuses a folder whose name is not the manifest id, so the
    // destination folder is named by the id — never by the listed path's own basename, which for
    // a build output is `dist`. Re-checked rather than assumed: `PluginId`'s charset already
    // forbids a separator, and this is the line that keeps that true if the charset ever widens.
    const target = NodePath.resolve(destRoot, manifest.id);
    if (NodePath.basename(target) !== manifest.id || !isWithinRoot(destRoot, target)) {
      skip(source, `manifest id "${manifest.id}" is not usable as a folder name`);
      continue;
    }

    const first = seen.get(manifest.id);
    if (first !== undefined) {
      skip(source, `duplicate id "${manifest.id}" — already staged from ${first}`);
      continue;
    }

    // `dereference: true` — see the module doc: a symlink in the payload is both unscannable at
    // boot and unextractable on Windows.
    NodeFS.cpSync(dir, target, { recursive: true, dereference: true });
    seen.set(manifest.id, source);
    const bytes = directoryBytes(target);
    bundled.push({ id: manifest.id, version: manifest.version, bytes, source });
    input.log(`SHIPPED ${manifest.id} ${manifest.version} ${String(bytes)}`);
  }

  input.log(
    `shipped plugins: ${String(bundled.length)} bundled, ${String(skipped.length)} skipped`,
  );
  return { bundled, skipped };
}

/**
 * `pnpm stage:plugins` — stage `ru-code/packaging/shipped-plugins.json` into `apps/server/dist/plugins`.
 *
 * Exported so `apps/server/scripts/cli.ts` runs the SAME entry point the script does, rather than
 * a second copy of the defaults.
 */
export async function stageShippedPluginsCli(input: {
  readonly appRoot: string;
  readonly destDir?: string;
  readonly log?: (message: string) => void;
}): Promise<StageResult> {
  const log =
    input.log ?? ((message: string) => process.stdout.write(`[stage-plugins] ${message}\n`));
  return stageShippedPlugins({
    appRoot: input.appRoot,
    listPath: NodePath.join(input.appRoot, SHIPPED_PLUGINS_LIST_RELATIVE),
    destDir: input.destDir ?? NodePath.join(input.appRoot, SHIPPED_PLUGINS_DIST_RELATIVE),
    decode: await loadManifestDecoder(input.appRoot),
    log,
  });
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined &&
  NodePath.resolve(invokedPath) === NodeURL.fileURLToPath(import.meta.url);

if (isMain) {
  const appRoot = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../../..",
  );
  await stageShippedPluginsCli({ appRoot });
}
