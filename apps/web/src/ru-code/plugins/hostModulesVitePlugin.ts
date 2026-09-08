// @effect-diagnostics nodeBuiltinImport:off -- vite build plugin runs in Node, not an Effect runtime
// ru-code: the host-provided modules import map (mvp-plan D13).
//
// WHY: a dropped-in plugin's `web/index.mjs` contains bare imports — `import { useState }
// from "react"` — and nothing else (the SDK build helper marks exactly
// `HOST_PROVIDED_MODULES` external and inlines the rest, D14). The browser can only
// resolve a bare specifier through an IMPORT MAP, so the app must ship one. Verification
// V3 measured `grep -c importmap dist/index.html` = 0; this plugin is what makes it 1.
//
// HOW: one extra Rollup ENTRY per provided specifier (`hostModules/<slug>.ts`, generated
// by `scripts/gen-host-modules.mjs`) that only re-exports the module. Because those
// entries join the app's own module graph, Rollup's chunk sharing puts react/effect in the
// SAME shared chunk the app imports — so the plugin gets the host's ONE instance, which is
// the whole point (a second React would break hooks and context silently). The map then
// points each specifier at that entry's hashed URL.
//
// Dev server: NOT supported (mvp-plan D9 — build packages, copy dist, `pnpm build`, run
// dist). This plugin is `apply: "build"` for that reason; there is deliberately no
// serve-mode branch.
//
// Electron (`apps/desktop`) loads the same dist from a file-backed shell where `/assets/...`
// does not resolve. The map is inert there — an import map only participates when a bare
// specifier is actually resolved, and the app's own code never uses one — so nothing is
// guarded on the target. Plugins in Electron are out of MVP scope (mvp-plan §5).

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { HOST_PROVIDED_MODULES } from "@smart-tools/plugin-sdk/contracts";
import type { Plugin } from "vite-plus";

import { hostModuleEntryName, hostModuleSlug, hostModuleSlugs } from "./hostModuleSlug";

/**
 * `apps/web` on disk. Vite bundles this file into its config graph, so the module URL is the
 * only self-describing anchor; the `root` fallback covers a config loader that rewrites it.
 */
function resolveWebRoot(root: string): string {
  const fromModule = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../../..",
  );
  if (NodeFS.existsSync(NodePath.join(fromModule, "src/ru-code/plugins/hostModules"))) {
    return fromModule;
  }
  return root;
}

const hostModulesSourceDir = (webRoot: string): string =>
  NodePath.join(webRoot, "src/ru-code/plugins/hostModules");

/** `assets/host-modules/manifest.json` — spec → url + guaranteed version, for diagnostics. */
const MANIFEST_FILE_NAME = "assets/host-modules/manifest.json";

export interface HostModuleMapping {
  readonly specifier: string;
  readonly version: string;
  readonly url: string;
}

/** The Rollup `input` entries for every host-provided module, keyed by entry name. */
export function hostModuleInputs(webRoot: string): Record<string, string> {
  hostModuleSlugs(HOST_PROVIDED_MODULES.map((entry) => entry.specifier));
  const sourceDir = hostModulesSourceDir(webRoot);
  const inputs: Record<string, string> = {};
  for (const { specifier } of HOST_PROVIDED_MODULES) {
    inputs[hostModuleEntryName(specifier)] = NodePath.join(
      sourceDir,
      `${hostModuleSlug(specifier)}.ts`,
    );
  }
  return inputs;
}

/** `<script type="importmap">` text for the resolved mappings. */
export function renderImportMap(mappings: ReadonlyArray<HostModuleMapping>): string {
  const imports: Record<string, string> = {};
  for (const mapping of mappings) {
    imports[mapping.specifier] = mapping.url;
  }
  return `<script type="importmap">${JSON.stringify({ imports })}</script>`;
}

/**
 * Insert the import map into `<head>` BEFORE anything module-flavoured.
 *
 * An import map must precede the first `<script type="module">` AND the first
 * `<link rel="modulepreload">` — Vite injects both into `<head>` during the build — so the
 * only always-correct anchor is the opening `<head>` tag itself.
 */
export function injectImportMap(html: string, script: string): string {
  const headOpen = /<head(\s[^>]*)?>/i.exec(html);
  if (headOpen === null) {
    // No <head> to anchor on: prepend so the map is still first in document order.
    return `${script}\n${html}`;
  }
  const at = headOpen.index + headOpen[0].length;
  return `${html.slice(0, at)}\n    ${script}${html.slice(at)}`;
}

/**
 * spec → emitted chunk URL, read out of the finished Rollup bundle.
 *
 * Derived on demand rather than cached between hooks: `generateBundle` and
 * `transformIndexHtml` are not ordered against Vite's own html plugin in a way this plugin
 * can rely on (a cached value populated in `generateBundle` was still empty when the html
 * transform ran), and both hooks are handed the bundle anyway.
 */
export function resolveHostModuleMappings(
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
  readonly mappings: ReadonlyArray<HostModuleMapping>;
  readonly missing: ReadonlyArray<string>;
} {
  const byEntryName = new Map<string, string>();
  for (const [fileName, output] of Object.entries(bundle)) {
    if (output.type === "chunk" && output.isEntry === true && output.name !== undefined) {
      byEntryName.set(output.name, fileName);
    }
  }
  const mappings: HostModuleMapping[] = [];
  const missing: string[] = [];
  for (const { specifier, version } of HOST_PROVIDED_MODULES) {
    const fileName = byEntryName.get(hostModuleEntryName(specifier));
    if (fileName === undefined) {
      missing.push(specifier);
      continue;
    }
    mappings.push({ specifier, version, url: `${base}${fileName}` });
  }
  return { mappings, missing };
}

export function hostModulesPlugin(): Plugin {
  let base = "/";

  return {
    name: "ru-code:plugin-host-modules",
    apply: "build",
    // `pre` so the extra inputs are merged before any plugin that reads the final input list.
    enforce: "pre",

    config(userConfig) {
      const webRoot = resolveWebRoot(NodePath.resolve(userConfig.root ?? process.cwd()));
      return {
        build: {
          rollupOptions: {
            input: {
              index: NodePath.join(webRoot, "index.html"),
              ...hostModuleInputs(webRoot),
            },
            // The generated entries exist ONLY for their exports; without this Rollup is
            // free to drop an entry's exports when nothing in the graph imports them.
            preserveEntrySignatures: "allow-extension",
          },
        },
      };
    },

    configResolved(config) {
      base = config.base;
    },

    generateBundle(_options, bundle) {
      const { mappings, missing } = resolveHostModuleMappings(bundle, base);
      if (missing.length > 0) {
        // Fail the build: a silently-missing entry means a plugin importing that specifier
        // dies in the page with an unresolvable-specifier error and no build-time signal.
        this.error(
          `ru-code:plugin-host-modules — no emitted entry for: ${missing.join(", ")}. ` +
            `Re-run src/ru-code/plugins/scripts/gen-host-modules.mjs.`,
        );
      }

      this.emitFile({
        type: "asset",
        fileName: MANIFEST_FILE_NAME,
        source: `${JSON.stringify(
          {
            apiNote:
              "Host-provided modules exposed to plugins through the index.html import map (D13).",
            modules: mappings,
          },
          null,
          2,
        )}\n`,
      });
    },

    // `order: "post"` — NOT "pre". A `pre` html hook runs at the html TRANSFORM stage, before
    // bundling, where `ctx.bundle` is undefined and the hashed chunk names do not exist yet
    // (measured: "transformIndexHtml fired, bundle? false"). `post` runs once the bundle is
    // final, with Vite's own script/preload tags already in the html — hence the <head>-open
    // anchor below, which is ahead of every one of them.
    //
    // Vite then normalises the tag's position, landing it immediately before the entry
    // `<script type="module">` and ahead of every `<link rel="modulepreload">` (measured in
    // `dist/index.html`). Both the anchor and that normalisation satisfy the one thing that
    // matters — the map precedes anything that resolves a specifier — and
    // `hostModulesDist.test.ts` asserts the property on the built file, so a change in
    // either fails the build gate instead of silently shipping an unusable map.
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (bundle === undefined) return html;
        const { mappings } = resolveHostModuleMappings(bundle, base);
        if (mappings.length === 0) return html;
        return injectImportMap(html, renderImportMap(mappings));
      },
    },
  };
}
