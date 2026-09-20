// @effect-diagnostics nodeBuiltinImport:off -- a vite build plugin runs in Node, not an Effect runtime
// ru-code v2: the shared-runtime import map (architecture.md §3).
//
// WHY. A dropped-in plugin's `web/index.mjs` contains bare imports — `import { useState } from
// "react"` — and nothing else. The browser can only resolve a bare specifier through an IMPORT
// MAP, so the app must ship one, and the chunk it points at must be the app's OWN: Rollup's chunk
// sharing is what makes the plugin's React the same instance as the app's, with no shim, no global
// and no binding order to get wrong.
//
// HOW, AND WHAT CHANGED FROM v1. Same mechanism, one extra Rollup ENTRY per shared specifier whose
// only content is a re-export — but the entries are VIRTUAL. v1 generated them: 50 committed
// one-line files under `hostModules/`, a slug module with an injectivity proof, a 235-line
// generator script and a drift test that re-derived all of it, 620 lines to keep a handful of re-exports on
// disk. Nothing read those files but Rollup. Here the plugin resolves and loads them itself, so
// the list in `shared.json` is the only thing to maintain.
//
// The CJS half is the one detail worth keeping: `export * from "react"` re-exports NOTHING, because
// a CommonJS module has no statically-known named exports. So a CJS specifier's names are read out
// of the real module, in Node, at build time, and re-exported explicitly — measured: the first
// build's `react` entry shipped only `default`.
//
// Dev server: NOT supported, by design (build packages → copy dist → build the app → run dist).
// This plugin is `apply: "build"` for that reason; there is deliberately no serve-mode branch.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { Plugin } from "vite-plus";

import sharedJson from "./shared.json";

/** `{ specifier: major }` — the ONE list (rules.md §2.8). `shared.test.ts` pins it to the SDK's. */
export const SHARED_SPECIFIERS: ReadonlyArray<string> = Object.keys(sharedJson);

/** `react/jsx-runtime` → `shared-react__jsx-runtime`. A Rollup entry NAME, so it must be a file-ish word. */
export const sharedEntryName = (specifier: string): string =>
  `shared-${specifier.replace(/^@/, "").replaceAll("/", "__")}`;

/** The virtual module id Rollup is handed as an input. */
const VIRTUAL_PREFIX = "\0ru-code:shared:";
const entryId = (specifier: string): string => `${VIRTUAL_PREFIX}${specifier}`;

/** `assets/shared-modules.json` — spec → url, for diagnostics and for the dist test. */
const MANIFEST_FILE_NAME = "assets/shared-modules.json";

export interface SharedModuleMapping {
  readonly specifier: string;
  readonly url: string;
}

/** `<script type="importmap">` text for the resolved mappings. */
export function renderImportMap(mappings: ReadonlyArray<SharedModuleMapping>): string {
  const imports: Record<string, string> = {};
  for (const mapping of mappings) imports[mapping.specifier] = mapping.url;
  return `<script type="importmap">${JSON.stringify({ imports })}</script>`;
}

/**
 * Insert the import map into `<head>` BEFORE anything module-flavoured.
 *
 * An import map must precede the first `<script type="module">` AND the first
 * `<link rel="modulepreload">`; Vite injects both into `<head>` during the build, so the only
 * always-correct anchor is the opening `<head>` tag itself.
 */
export function injectImportMap(html: string, script: string): string {
  const headOpen = /<head(\s[^>]*)?>/i.exec(html);
  if (headOpen === null) return `${script}\n${html}`;
  const at = headOpen.index + headOpen[0].length;
  return `${html.slice(0, at)}\n    ${script}${html.slice(at)}`;
}

/**
 * spec → emitted chunk URL, read out of the finished Rollup bundle.
 *
 * Derived on demand rather than cached between hooks: `generateBundle` and `transformIndexHtml`
 * are not ordered against Vite's own html plugin in a way this plugin can rely on (a value
 * populated in `generateBundle` was still empty when the html transform ran), and both hooks are
 * handed the bundle anyway.
 */
export function resolveSharedMappings(
  bundle: Readonly<
    Record<
      string,
      {
        readonly type: string;
        readonly name?: string | undefined;
        readonly isEntry?: boolean | undefined;
      }
    >
  >,
  base: string,
): {
  readonly mappings: ReadonlyArray<SharedModuleMapping>;
  readonly missing: ReadonlyArray<string>;
} {
  const byEntryName = new Map<string, string>();
  for (const [fileName, output] of Object.entries(bundle)) {
    if (output.type === "chunk" && output.isEntry === true && output.name !== undefined) {
      byEntryName.set(output.name, fileName);
    }
  }
  const mappings: SharedModuleMapping[] = [];
  const missing: string[] = [];
  for (const specifier of SHARED_SPECIFIERS) {
    const fileName = byEntryName.get(sharedEntryName(specifier));
    if (fileName === undefined) missing.push(specifier);
    else mappings.push({ specifier, url: `${base}${fileName}` });
  }
  return { mappings, missing };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The virtual entry's source
// ─────────────────────────────────────────────────────────────────────────────────────────────

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The re-export module for one shared specifier.
 *
 * ESM: `export * from "<spec>"`, plus `export { default }` when the source declares one.
 * CJS: `export *` emits nothing, so the names the bundler's interop synthesises are ENUMERATED by
 * importing the module here, in Node, and re-exported explicitly.
 *
 * `file` is the module THE BUILD will bundle, resolved through the plugin container (`this.resolve`
 * in `load` below) rather than by `require.resolve`. The two disagree, and the disagreement ships:
 * `require.resolve("zustand")` answers the CJS entry, so this would emit `export { default }` for a
 * browser build that resolves the ESM entry — which has no default, and the build fails on a
 * MISSING_EXPORT nobody wrote. One resolver, the build's own.
 */
export async function sharedEntrySource(file: string, specifier: string): Promise<string> {
  const source = NodeFS.readFileSync(file, "utf8");
  const isEsm = /(^|[\s;}])(export|import)[\s{*]/m.test(source);
  const header = `// GENERATED by ru-code:shared-modules — the import-map entry for "${specifier}".\n`;
  if (isEsm) {
    const hasDefault =
      /(^|[\s;}])export\s+default[\s({]/m.test(source) || /\bas\s+default\b/.test(source);
    return (
      header +
      `export * from ${JSON.stringify(specifier)};\n` +
      (hasDefault ? `export { default } from ${JSON.stringify(specifier)};\n` : "")
    );
  }
  const namespace = (await import(NodeURL.pathToFileURL(file).href)) as Record<string, unknown>;
  const names = Object.keys(namespace)
    .filter((name) => name !== "default" && name !== "__esModule" && IDENTIFIER.test(name))
    .sort();
  return (
    header +
    `// "${specifier}" is CommonJS: \`export *\` from CJS re-exports nothing, so its runtime names\n` +
    "// are enumerated at build time and re-exported by name.\n" +
    (names.length === 0
      ? ""
      : `export { ${names.join(", ")} } from ${JSON.stringify(specifier)};\n`) +
    `export { default } from ${JSON.stringify(specifier)};\n`
  );
}

/**
 * `apps/web` on disk. Vite bundles this file into its config graph, so the module URL is the only
 * self-describing anchor; the `root` fallback covers a config loader that rewrites it.
 */
function resolveWebRoot(root: string): string {
  const fromModule = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../../..",
  );
  return NodeFS.existsSync(NodePath.join(fromModule, "src/ru-code/plugins/shared.json"))
    ? fromModule
    : root;
}

export function sharedModulesPlugin(): Plugin {
  let base = "/";

  return {
    name: "ru-code:plugin-shared-modules",
    apply: "build",
    // `pre` so the extra inputs are merged before any plugin that reads the final input list.
    enforce: "pre",

    config(userConfig) {
      const webRoot = resolveWebRoot(NodePath.resolve(userConfig.root ?? process.cwd()));
      const input: Record<string, string> = {
        index: NodePath.join(webRoot, "index.html"),
      };
      for (const specifier of SHARED_SPECIFIERS)
        input[sharedEntryName(specifier)] = entryId(specifier);
      return {
        build: {
          rollupOptions: {
            input,
            // The entries exist ONLY for their exports; without this Rollup is free to drop them.
            preserveEntrySignatures: "allow-extension",
          },
        },
      };
    },

    configResolved(config) {
      base = config.base;
    },

    resolveId(id) {
      return id.startsWith(VIRTUAL_PREFIX) ? id : null;
    },

    async load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const specifier = id.slice(VIRTUAL_PREFIX.length);
      // `this.resolve` is the BUILD's resolver — browser/module/import conditions, aliases and all
      // — which is the only answer that can agree with what Rollup then bundles.
      const resolved = await this.resolve(specifier, undefined, { skipSelf: true });
      if (resolved === null) {
        this.error(
          `ru-code:plugin-shared-modules — cannot resolve the shared package "${specifier}". ` +
            "Every entry of shared.json must be a package the app itself installs.",
        );
      }
      return await sharedEntrySource(resolved.id.split("?")[0] ?? resolved.id, specifier);
    },

    generateBundle(_options, bundle) {
      const { mappings, missing } = resolveSharedMappings(bundle, base);
      if (missing.length > 0) {
        // Fail the build: a silently-missing entry means a plugin importing that specifier dies in
        // the page with an unresolvable-specifier error and no build-time signal.
        this.error(`ru-code:plugin-shared-modules — no emitted entry for: ${missing.join(", ")}`);
      }
      this.emitFile({
        type: "asset",
        fileName: MANIFEST_FILE_NAME,
        source: `${JSON.stringify({ modules: mappings }, null, 2)}\n`,
      });
    },

    // `order: "post"` — NOT "pre". A `pre` html hook runs at the html TRANSFORM stage, before
    // bundling, where `ctx.bundle` is undefined and the hashed chunk names do not exist yet. `post`
    // runs once the bundle is final, with Vite's own script/preload tags already in the html —
    // hence the <head>-open anchor, which is ahead of every one of them.
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (bundle === undefined) return html;
        const { mappings } = resolveSharedMappings(bundle, base);
        if (mappings.length === 0) return html;
        return injectImportMap(html, renderImportMap(mappings));
      },
    },
  };
}
