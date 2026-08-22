// ru-code: build the installed wrapper layout from an extracted release payload — the ONE place
// that knows the on-disk shape (`cli.js` wrapper + `current.json` pointer + `versions/<v>/`).
// Consumers: the e2e live-cycle harness (installs real release artifacts into a sandbox appRoot)
// and the system installer (same call, real target). Idempotent: re-installing the same version
// overwrites the version dir and re-points the pointer.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { APP_COMMAND, APP_NAME, SUPPORT_CHANNEL_URL } from "@ru-code/branding";

import { VERSIONS_DIRNAME } from "../apply/gc.ts";
import { VERSION_ENTRY_FILENAME } from "../apply/fetchVersion.ts";
import {
  makePointer,
  POINTER_FILENAME,
  writePointer,
  type PointerWriteError,
} from "../apply/pointer.ts";
import { makeWrapperSource } from "./wrapperSource.ts";

export const WRAPPER_FILENAME = "cli.js";

/**
 * The module declaration for the bundle ROOT, beside the frozen wrapper.
 *
 * The wrapper is ESM (`import * as fs from "node:fs"`) but `.js` says nothing about that. With no
 * `package.json` above it, Node has to DETECT the module kind from the source on every launch
 * instead of being told, and on the node 22 line that detection also prints
 * `MODULE_TYPELESS_PACKAGE_JSON`. Declaring the type removes both the guess and the warning.
 *
 * It does not reproduce from inside the repo, whose root package.json already declares
 * `"type": "module"` — only an install whose path has no package.json anywhere above it sees it.
 * Nor does it reproduce on node 24, which no longer prints the warning; the supported floor is
 * `^22.16`, so a shipped install can land on either behaviour.
 *
 * NOT written into `versions/<v>/`: that directory ships its own slim package.json (also
 * `type: module`) and the nearer file wins. This one covers the wrapper alone.
 */
export const WRAPPER_PACKAGE_FILENAME = "package.json";
export const wrapperPackageSource = (): string =>
  `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`;

export interface InstalledLayout {
  readonly appRoot: string;
  /** `<appRoot>/cli.js` — what users launch. */
  readonly wrapperPath: string;
  readonly versionDir: string;
}

/**
 * Install `payloadDir` (an extracted release payload carrying `cli.js`) as `version` under
 * `appRoot`, emit the frozen wrapper, and point `current.json` at it.
 */
export const buildInstalledLayout = (params: {
  readonly appRoot: string;
  readonly payloadDir: string;
  readonly version: string;
}): Effect.Effect<InstalledLayout, PointerWriteError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const versionDir = path.join(params.appRoot, VERSIONS_DIRNAME, params.version);
    yield* fs.remove(versionDir, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
    yield* fs
      .makeDirectory(path.join(params.appRoot, VERSIONS_DIRNAME), { recursive: true })
      .pipe(Effect.orElseSucceed(() => undefined));
    yield* fs.copy(params.payloadDir, versionDir).pipe(Effect.orElseSucceed(() => undefined));

    const wrapperPath = yield* writeLauncher(params);
    return { appRoot: params.appRoot, wrapperPath, versionDir };
  });

/**
 * Write JUST the launcher pair — the frozen wrapper and the pointer at `versions/<version>` —
 * into `appRoot`. Split out because the RELEASE BUILD needs exactly this and nothing else: it
 * stages the payload straight into `versions/<version>/`, then calls here so the bundle it ships
 * carries the same two files an install would have produced (see `scripts/emitBundleLayout.ts`).
 * Returns the wrapper's path.
 */
export const writeLauncher = (params: {
  readonly appRoot: string;
  readonly version: string;
}): Effect.Effect<string, PointerWriteError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const wrapperPath = path.join(params.appRoot, WRAPPER_FILENAME);
    yield* fs
      .writeFileString(
        wrapperPath,
        makeWrapperSource({
          appName: APP_NAME,
          appCommand: APP_COMMAND,
          supportUrl: SUPPORT_CHANNEL_URL,
        }),
      )
      .pipe(Effect.orElseSucceed(() => undefined));

    yield* fs
      .writeFileString(path.join(params.appRoot, WRAPPER_PACKAGE_FILENAME), wrapperPackageSource())
      .pipe(Effect.orElseSucceed(() => undefined));

    yield* writePointer(
      params.appRoot,
      makePointer(
        params.version,
        `${VERSIONS_DIRNAME}/${params.version}/${VERSION_ENTRY_FILENAME}`,
      ),
    );
    return wrapperPath;
  });

/**
 * The layout's file/directory names, as data — printed by `scripts/emitBundleLayout.ts paths` so
 * the release script can stage into `versions/<v>/` without hardcoding (or importing) any of them.
 */
export const layoutNames = {
  wrapper: WRAPPER_FILENAME,
  wrapperPackage: WRAPPER_PACKAGE_FILENAME,
  pointer: POINTER_FILENAME,
  versionsDir: VERSIONS_DIRNAME,
  entry: VERSION_ENTRY_FILENAME,
} as const;
