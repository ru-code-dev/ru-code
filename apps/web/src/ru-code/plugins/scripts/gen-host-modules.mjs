// ru-code: generator for the host-provided module entry files (D13).
//
// Run from apps/web:  node src/ru-code/plugins/scripts/gen-host-modules.mjs
//                     pnpm exec vp fmt src/ru-code/plugins/hostModules
//
// The formatter pass is part of the step, not an afterthought: this script emits the CJS
// re-export list one name per line, and oxfmt collapses a short one back onto a single line —
// so skipping it leaves a formatting-only diff on the three CJS entries.
//
// WHY generated-and-committed rather than virtual: the entries must be REAL source
// files so `tsgo`, oxlint and the Vite build all see the same graph, and so a diff
// shows exactly which specifiers the host promises. `hostModules.test.ts` re-derives
// the expected set from `HOST_PROVIDED_MODULES` and fails when this output drifts,
// so the commit and the contract can never disagree silently.
//
// WHY the `export { default }` line is conditional: `export *` never re-exports a
// default, so a plugin doing `import React from "react"` needs the explicit line —
// but emitting it for a module that has no default (`zustand`, `lucide-react`,
// every `effect/*`) is a hard build error. `hasDefaultExport()` below answers that
// the way VITE will resolve the package (browser/module/import conditions, `module`
// field before `main`), NOT the way bare `node --conditions browser` does: node has
// no `module` field, so it resolves lucide-react to its CJS build and reports a
// default that the ESM build Vite bundles does not have.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

const scriptDir = NodePath.dirname(new URL(import.meta.url).pathname);
const pluginsDir = NodePath.resolve(scriptDir, "..");
const outDir = NodePath.join(pluginsDir, "hostModules");
const webRoot = NodePath.resolve(pluginsDir, "../../..");

const { HOST_PROVIDED_MODULES } = await import("@smart-tools/plugin-sdk/contracts");
const { hostModuleSlug, hostModuleSlugs } = await import(
  NodeURL.pathToFileURL(NodePath.join(pluginsDir, "hostModuleSlug.ts")).href
).catch(async () => {
  // The .ts entry cannot be imported by bare node; mirror the (deliberately tiny) rule.
  const slug = (specifier) => specifier.replace(/^@/, "").replaceAll("/", "__");
  return { hostModuleSlug: slug, hostModuleSlugs: (all) => all.map(slug) };
});

const require = NodeModule.createRequire(NodePath.join(webRoot, "noop.js"));

/** The package name part of a specifier (`@base-ui/react/dialog` → `@base-ui/react`). */
function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Locate the installed package directory by walking node_modules upward from apps/web. */
function packageDirOf(packageName) {
  let dir = webRoot;
  for (;;) {
    const candidate = NodePath.join(dir, "node_modules", packageName);
    if (NodeFS.existsSync(NodePath.join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = NodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    return NodePath.dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    throw new Error(`host-modules: cannot locate installed package "${packageName}"`);
  }
}

const CONDITIONS = ["module", "browser", "import", "default"];

/** Minimal `exports`-map resolution under the conditions Vite uses for a browser build. */
function resolveExports(node, subpath) {
  if (node === null || node === undefined) return null;
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    for (const entry of node) {
      const resolved = resolveExports(entry, subpath);
      if (resolved !== null) return resolved;
    }
    return null;
  }
  const keys = Object.keys(node);
  const isSubpathMap = keys.some((key) => key === "." || key.startsWith("./"));
  if (isSubpathMap) {
    if (node[subpath] !== undefined) return resolveExports(node[subpath], subpath);
    // Wildcard patterns (`"./*": "./dist/*.js"`) — effect 4 is entirely wildcard-based.
    for (const key of keys) {
      if (!key.includes("*")) continue;
      const [prefix, suffix] = key.split("*");
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
      const star = subpath.slice(prefix.length, subpath.length - suffix.length);
      const target = resolveExports(node[key], subpath);
      if (target !== null) return target.replaceAll("*", star);
    }
    return null;
  }
  for (const condition of CONDITIONS) {
    if (node[condition] !== undefined) {
      const resolved = resolveExports(node[condition], subpath);
      if (resolved !== null) return resolved;
    }
  }
  return null;
}

/** The file Vite will actually bundle for this specifier. */
function resolveLikeVite(specifier) {
  const packageName = packageNameOf(specifier);
  const packageDir = packageDirOf(packageName);
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(packageDir, "package.json"), "utf8"),
  );
  const rest = specifier.slice(packageName.length);
  const subpath = rest === "" ? "." : `.${rest}`;

  let target = null;
  if (manifest.exports !== undefined) {
    target = resolveExports(manifest.exports, subpath);
  } else if (subpath === ".") {
    target =
      (typeof manifest.browser === "string" ? manifest.browser : null) ??
      manifest.module ??
      manifest.main ??
      "index.js";
  } else {
    target = subpath;
  }
  if (target === null) {
    throw new Error(`host-modules: cannot resolve "${specifier}" from ${packageDir}`);
  }

  const base = NodePath.join(packageDir, target);
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, NodePath.join(base, "index.js")]) {
    if (NodeFS.existsSync(candidate) && NodeFS.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`host-modules: resolved "${specifier}" to a missing file (${base})`);
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The export shape of the file Vite will bundle for this specifier.
 *
 * `esm`  — `export * from` works verbatim; `default` only when the source declares one.
 * `cjs`  — `export * from` emits NOTHING (a CJS module has no statically-known named
 *          exports, so Rollup re-exports an empty set; measured: the first build's
 *          `react` entry shipped only `default`). The interop DOES synthesise both a
 *          `default` and the names cjs-module-lexer finds, so those names are enumerated
 *          here and re-exported explicitly.
 */
async function exportShapeOf(specifier) {
  const file = resolveLikeVite(specifier);
  const source = NodeFS.readFileSync(file, "utf8");
  const isEsm = /(^|[\s;}])(export|import)[\s{*]/m.test(source);
  if (isEsm) {
    const hasDefault =
      /(^|[\s;}])export\s+default[\s({]/m.test(source) || /\bas\s+default\b/.test(source);
    return { kind: "esm", hasDefault, names: [] };
  }
  const namespace = await import(NodeURL.pathToFileURL(file).href);
  const names = Object.keys(namespace)
    .filter((name) => name !== "default" && name !== "__esModule" && IDENTIFIER.test(name))
    .sort();
  return { kind: "cjs", hasDefault: true, names };
}

const specifiers = HOST_PROVIDED_MODULES.map((entry) => entry.specifier);
hostModuleSlugs(specifiers); // injectivity guard

NodeFS.rmSync(outDir, { recursive: true, force: true });
NodeFS.mkdirSync(outDir, { recursive: true });

const header = (specifier) =>
  `// ru-code: GENERATED by scripts/gen-host-modules.mjs — do not edit by hand.
// Host-provided module entry for "${specifier}" (D13). Its only job is to be a Rollup
// ENTRY that re-exports the app's own instance, so the emitted chunk shares the app's
// react/effect chunks and the import map can point "${specifier}" at it.
`;

const rows = [];
for (const specifier of specifiers) {
  const slug = hostModuleSlug(specifier);
  const shape = await exportShapeOf(specifier);
  const lines = [];
  if (shape.kind === "cjs") {
    // `@ts-nocheck` — the repo's convention for a generated file (`src/routeTree.gen.ts:3`).
    // A CJS package's RUNTIME export names (what cjs-module-lexer finds, and therefore what
    // the bundler's interop actually provides) are a superset of what its `.d.ts` declares:
    // `react` really exports `__COMPILER_RUNTIME`, `react-dom/client` really exports
    // `version`, and `@types/react` declares neither. Nothing imports these entry modules —
    // they exist only to be Rollup entries — so their TYPE surface is never consumed, while
    // dropping the names would leave a plugin's `import { version } from "react-dom/client"`
    // unresolvable at runtime. The specifier itself stays pinned by `hostModules.test.ts`
    // and by the build, which is what a typo here would actually break.
    lines.push("// @ts-nocheck -- generated CJS re-export, see the note below");
  }
  // `header()` already ends in a newline and the join below adds another, so pushing a further
  // empty line here left TWO blank lines and made every regeneration dirty all 47 files with a
  // formatting-only diff the repo's formatter then reverted (measured at A16).
  lines.push(header(specifier));
  if (shape.kind === "cjs") {
    lines.push(
      `// "${specifier}" is CommonJS: its named exports are the ones the bundler's interop`,
      "// synthesises, so they are listed explicitly — `export *` from CJS re-exports nothing",
      "// (measured: the first build's `react` entry shipped only `default`).",
      `export {\n${shape.names.map((name) => `  ${name},`).join("\n")}\n} from "${specifier}";`,
    );
  } else {
    lines.push(`export * from "${specifier}";`);
  }
  if (shape.hasDefault) {
    lines.push(`export { default } from "${specifier}";`);
  }
  NodeFS.writeFileSync(NodePath.join(outDir, `${slug}.ts`), `${lines.join("\n")}\n`, "utf8");
  rows.push({
    specifier,
    slug,
    kind: shape.kind,
    default: shape.hasDefault,
    names: shape.names.length,
  });
}

console.log(
  `[gen-host-modules] wrote ${rows.length} entries to ${NodePath.relative(webRoot, outDir)}`,
);
for (const row of rows) {
  const shape =
    row.kind === "cjs"
      ? `cjs  ${String(row.names).padStart(3)} names +default`
      : "esm  *" + (row.default ? " +default" : "        ");
  console.log(`  ${shape.padEnd(24)} ${row.slug.padEnd(34)} ${row.specifier}`);
}
