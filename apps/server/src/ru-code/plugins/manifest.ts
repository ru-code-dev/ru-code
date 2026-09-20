/**
 * ru-code: read + validate ONE plugin folder's `plugin.json`.
 *
 * WHY this is a module of its own and why it never throws. A plugin folder is
 * user-supplied content dropped into `<baseDir>/plugins/` — it is not part of
 * the install payload and nothing validated it before it landed. Every rule
 * below therefore exists to answer one question: "may the host execute or serve
 * anything from this folder?" A `false` answer must be a REPORTED skip (the
 * Plugins UI has to be able to say *why* a folder did not load), never an
 * exception that takes the scan — or the server — down (guardrail 8).
 *
 * The rules, and the reason for each:
 *  - the manifest must decode against the SDK schema (`decodePluginManifest`),
 *    which is the single source of truth shared with plugin authors;
 *  - D8: `manifest.id` must equal the folder name. The folder name is what the
 *    HTTP asset route and the RPC id space address, so a manifest claiming a
 *    different id would make one plugin reachable under another's name;
 *  - `apiVersion` must be supported by THIS host (`isSupportedApiVersion`) — a
 *    plugin built against a future major would call host APIs that do not exist;
 *  - `server` / `web` / `styles` must be folder-relative, `..`-free, NUL-free and
 *    must actually resolve to a file inside the plugin folder — checked on the
 *    lexical path AND on `realPath`, so a symlinked entry pointing out of the
 *    folder is refused (A4 finding M1: `path.resolve` alone does not follow
 *    links, and a linked `server/index.mjs` was imported and executed). This is
 *    defence in depth: the SDK's `PluginRelativePath` already rejects the obvious
 *    shapes at parse time, but the manifest is data on disk and the loader/route
 *    act on these strings, so the containment check is repeated where it is used.
 *
 * A declared-but-missing entry is a SKIP rather than a load with a hole: a
 * plugin whose `web` file is absent would otherwise 404 at runtime with no
 * explanation anywhere.
 *
 * @module ru-code/plugins/manifest
 */
import {
  decodePluginManifest,
  isSupportedApiVersion,
  majorOf,
  PLUGIN_API_VERSION,
  SHARED_PACKAGES,
  sharedPackageMajor,
  type PluginManifest,
  type PluginSharedVersions,
} from "@smart-tools/plugin-sdk/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import { isWithinRoot } from "./paths.ts";

/** The manifest file every plugin folder must carry. */
export const PLUGIN_MANIFEST_FILENAME = "plugin.json";

/** Manifest fields that name a file inside the plugin folder. */
export const PLUGIN_MANIFEST_PATH_FIELDS = ["server", "web", "styles"] as const;

/**
 * One scanned folder: either a usable manifest, or a folder we refuse to use
 * together with the reason (surfaced as `PluginStatus.state = "skipped"`).
 */
export type PluginManifestEntry =
  | { readonly ok: true; readonly dir: string; readonly manifest: PluginManifest }
  | { readonly ok: false; readonly dir: string; readonly reason: string };

/**
 * Pure containment rules for a manifest-declared relative path.
 *
 * Returns `undefined` when the value is acceptable, otherwise the reason. Kept
 * pure (and exported) so the traversal matrix is unit-testable without a disk.
 */
export const validatePluginRelativePath = (field: string, value: string): string | undefined => {
  if (value.length === 0) return `${field} is empty`;
  if (value.includes("\0")) return `${field} contains a NUL byte`;
  if (value.startsWith("/") || value.startsWith("\\")) return `${field} must be relative`;
  // A Windows drive/UNC prefix is absolute even though it does not start with a separator.
  if (/^[a-zA-Z]:/.test(value)) return `${field} must be relative`;
  const segments = value.split(/[/\\]+/);
  if (segments.includes("..")) return `${field} escapes the plugin folder`;
  return undefined;
};

/**
 * ru-code v2 (architecture.md §1): does the plugin's `shared` stamp agree with THIS host?
 *
 * The stamp records the versions the plugin's bundle was compiled against for exactly the
 * specifiers it left external — the ones the app's import map will hand it at runtime. A MAJOR
 * mismatch is a plugin compiled against React 18 being handed React 19's chunk: hooks that do not
 * exist, a context shape that changed, and a failure with no message that names the cause. So it
 * is a SKIP with a reason, exactly like an unsupported `apiVersion`.
 *
 * A MINOR difference is normal — the plugin was built on a slightly older patch of the same major —
 * and is reported so an operator can see it in the log, never acted on.
 *
 * A specifier the host does not share at all is a plugin built against a different SHARED list; it
 * is reported as drift rather than a skip, because the import map simply will not resolve it and
 * `assertPluginBundle` should have refused it at the plugin's own build.
 */
export const sharedVersionDrift = (
  shared: PluginSharedVersions | undefined,
): { readonly mismatched: ReadonlyArray<string>; readonly drifted: ReadonlyArray<string> } => {
  const mismatched: Array<string> = [];
  const drifted: Array<string> = [];
  for (const [specifier, version] of Object.entries(shared ?? {})) {
    const hostMajor = sharedPackageMajor(specifier);
    if (hostMajor === undefined) {
      drifted.push(`${specifier} is not a shared package of this host`);
      continue;
    }
    const pluginMajor = majorOf(version);
    if (pluginMajor === null) {
      drifted.push(`${specifier}@${version} has no readable version`);
      continue;
    }
    if (pluginMajor !== hostMajor) {
      mismatched.push(`${specifier}: built against ${pluginMajor}.x, host ships ${hostMajor}.x`);
    }
  }
  return { mismatched, drifted };
};

/** Every specifier this host publishes, for a skip message a plugin author can act on. */
const HOST_SHARED = SHARED_PACKAGES.map((p) => `${p.specifier}@${p.major}`).join(", ");

const decodeManifestJson = (raw: string): Result.Result<PluginManifest, string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return Result.fail(
      `${PLUGIN_MANIFEST_FILENAME} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return decodePluginManifest(parsed);
};

/**
 * Read and validate `<dir>/plugin.json`.
 *
 * Never fails: an unreadable, malformed, mis-identified, wrong-API-version or
 * dangling-entry manifest comes back as `{ ok: false, reason }`.
 */
export const readPluginManifest = (
  dir: string,
): Effect.Effect<PluginManifestEntry, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const skip = (reason: string): PluginManifestEntry => ({ ok: false, dir, reason });

    const manifestPath = path.join(dir, PLUGIN_MANIFEST_FILENAME);
    const raw = yield* fs.readFileString(manifestPath).pipe(Effect.orElseSucceed(() => null));
    if (raw === null) return skip(`${PLUGIN_MANIFEST_FILENAME} is missing or unreadable`);

    const decoded = decodeManifestJson(raw);
    if (Result.isFailure(decoded)) return skip(decoded.failure);
    const manifest = decoded.success;

    // D8 — the folder name IS the plugin id everywhere else (routes, RPC, storage).
    const folderName = path.basename(dir);
    if (manifest.id !== folderName) {
      return skip(`manifest id "${manifest.id}" does not match folder name "${folderName}"`);
    }

    if (!isSupportedApiVersion(manifest.apiVersion)) {
      return skip(
        `apiVersion ${manifest.apiVersion} is not supported (host implements ${PLUGIN_API_VERSION})`,
      );
    }

    // v2: the shared-runtime contract. See {@link sharedVersionDrift}.
    const drift = sharedVersionDrift(manifest.shared);
    if (drift.mismatched.length > 0) {
      return skip(
        `shared package major mismatch (${drift.mismatched.join("; ")}); this host shares ${HOST_SHARED}`,
      );
    }

    for (const field of PLUGIN_MANIFEST_PATH_FIELDS) {
      const value = manifest[field];
      if (value === undefined) continue;
      const invalid = validatePluginRelativePath(field, value);
      if (invalid !== undefined) return skip(invalid);

      // Re-check containment on the RESOLVED path: normalisation is what turns
      // "a/../../b" style inputs into an escape even when no single segment is "..".
      const resolvedRoot = path.resolve(dir);
      const resolved = path.resolve(resolvedRoot, value);
      if (!isWithinRoot(path, resolvedRoot, resolved)) {
        return skip(`${field} escapes the plugin folder`);
      }

      const stat = yield* fs.stat(resolved).pipe(Effect.orElseSucceed(() => null));
      if (stat === null || stat.type !== "File") {
        return skip(`${field} "${value}" does not exist in the plugin folder`);
      }

      // ru-code (A5, A4 finding M1): and now the SAME check on the real path.
      // `path.resolve` is pure string arithmetic — it does not follow symlinks —
      // so `server/index.mjs` linked to a module anywhere on disk passed the
      // check above and was then imported and executed. A4 reproduced exactly
      // that. `scan.ts` (for the plugin DIRECTORY) and `httpRoutes.ts` (for a
      // served file) already resolve the real path before trusting it; this is
      // the third and last place that had to.
      //
      // Root resolved through `realPath` too: `~/.ru-code` is itself a symlink on
      // some setups, and comparing a real path against a non-real root would
      // reject every entry of a legitimately linked install.
      const realRoot = yield* fs
        .realPath(resolvedRoot)
        .pipe(Effect.orElseSucceed(() => resolvedRoot));
      const realEntry = yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => null));
      if (realEntry === null || !isWithinRoot(path, realRoot, realEntry)) {
        return skip(`${field} escapes the plugin folder`);
      }
    }

    return { ok: true, dir, manifest } satisfies PluginManifestEntry;
  }).pipe(Effect.withSpan("plugins.readPluginManifest", { attributes: { dir } }));
