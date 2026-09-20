// ru-code v2: write the app's THEME — the `@theme inline` block, the `dark` custom variant and the
// plain `@theme` font tokens — and the app's PALETTE — the two top-level `:root` blocks that carry
// the VALUES those tokens point at — into the plugin SDK, and stamp each body's hash.
//
// WHY (v1 finding H1). `@smart-tools/plugin-sdk/tailwind/theme.css` is the token→variable mapping
// that makes a plugin's `class="bg-background"` compile to a rule against the APP's own
// `--background` — so a plugin compiled with a stale copy silently produces utilities the app's
// variables no longer back, and a RENAMED token silently breaks a panel's colours. v1 kept the two
// in sync with a comment ("IT MUST BE RE-SYNCED WHEN THE APP'S BLOCK CHANGES") and no test on
// either side. They live in two repositories, so a plain assertion is not available — but a
// GENERATOR plus a stamped hash is:
//
//   · this script (the WRITER) extracts the block and writes the SDK file with a `sha256:` header;
//   · the SDK's own `tests/theme.test.ts` re-hashes the body and refuses a hand-edit of its copy;
//   · the app's `src/ru-code/tests/plugins/pluginTheme.test.ts` re-hashes THIS app's block and refuses a
//     copy that no longer matches it — which is the drift v1 could not see.
//
// The PALETTE (S7 §5.6 / S8) is the same guarantee for `tailwind/palette.css`, the playground's
// stand-in for the app's own document: it used to be a HAND-SYNCED copy, so a value the app changed
// showed the plugin author a colour the product no longer has. Same extraction, same stamped hash,
// same `--check`; `tests/playgroundPalette.test.ts` refuses a hand-edit of the SDK's copy.
//
// `--check` fails instead of writing (for a gate); the default rewrites the files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const webRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const repoRoot = NodePath.resolve(webRoot, "../..");
const INDEX_CSS = NodePath.resolve(webRoot, "src/index.css");
const MARKER = "@theme inline";
/** The PLAIN `@theme` block — `@theme {`, never `@theme inline {`. */
const PLAIN_THEME = /@theme\s*\{/;
/** `@custom-variant dark (…` — the app's dark mode is a CLASS, not `prefers-color-scheme`. */
const DARK_VARIANT = /@custom-variant\s+dark\s*\(/;

/** The block starting at `start`, braces balanced, verbatim. */
function blockAt(css, start, what) {
  const open = css.indexOf("{", start);
  if (open < 0) throw new Error(`gen-plugin-theme: ${what} has no body`);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1).trimEnd();
    }
  }
  throw new Error(`gen-plugin-theme: unbalanced braces in ${what}`);
}

/** The `@theme inline { … }` block of the app's stylesheet, braces balanced, verbatim. */
export function extractThemeInline(css) {
  const start = css.indexOf(MARKER);
  if (start < 0) throw new Error(`gen-plugin-theme: no \`${MARKER}\` block in the app stylesheet`);
  return blockAt(css, start, "`@theme inline`");
}

/**
 * The app's `@custom-variant dark (…)` line.
 *
 * WHY IT IS HERE (catalogs Host/SDK request R5). The app switches themes with a CLASS on the
 * document; Tailwind's default `dark:` variant is `prefers-color-scheme`. A plugin compiled without
 * this line therefore keys every `dark:` utility off the OPERATING SYSTEM — a light app on a dark
 * laptop paints the catalog's amber divergence warnings in their dark colours. The catalogs port
 * copied the line into its own `styles.css` by hand; this puts one copy in the generated file.
 */
export function extractDarkVariant(css) {
  const match = DARK_VARIANT.exec(css);
  if (match === null) {
    throw new Error("gen-plugin-theme: no `@custom-variant dark (…)` in the app stylesheet");
  }
  // Counted, not matched: the app's own selector is `(&:is(.dark, .dark *))` and a `\([^)]*\)`
  // regex closes on the INNER `)`, which is how the first version of this silently found nothing.
  let depth = 0;
  for (let i = match.index + match[0].length - 1; i < css.length; i += 1) {
    if (css[i] === "(") depth += 1;
    else if (css[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        const semicolon = css.indexOf(";", i);
        if (semicolon < 0) break;
        return css.slice(match.index, semicolon + 1).trim();
      }
    }
  }
  throw new Error("gen-plugin-theme: unbalanced parentheses in `@custom-variant dark`");
}

/**
 * The PLAIN `@theme { … }` block — the `--font-*` tokens.
 *
 * The app declares them outside `@theme inline` deliberately: a font stack is a VALUE, not a
 * pointer at another variable, so utilities must reference `var(--font-mono)` for Settings →
 * Appearance to be able to override it at runtime. A plugin compiled without them gets Tailwind's
 * default mono stack, which is a different font from the rest of the app in the same view.
 */
export function extractThemePlain(css) {
  const match = PLAIN_THEME.exec(css);
  if (match === null) throw new Error("gen-plugin-theme: no plain `@theme {` block");
  return blockAt(css, match.index, "the plain `@theme` block");
}

/** Everything the SDK copy carries, in the order Tailwind should read it. */
export function extractPluginTheme(css) {
  return `${extractDarkVariant(css)}\n\n${extractThemePlain(css)}\n\n${extractThemeInline(css)}`;
}

export const hashTheme = (block) =>
  NodeCrypto.createHash("sha256").update(block, "utf8").digest("hex");

/**
 * The two top-level `:root { … }` blocks the app's palette lives in, identified by CONTENT.
 *
 * Never by line number: S7 cited them as "≈86-120" and "≈1022-1129" and one edit above either one
 * moves both. The first is the compact-geometry block (scrollbars, insets, glass), the second the
 * semantic palette (`--background`, `--foreground`, the sidebar family, the status colours); each
 * carries its own `@variant dark { … }` arm, which is why the dark values need no second source.
 */
const PALETTE_BLOCKS = [
  { marker: "--app-scrollbar-width", what: "the compact-geometry `:root` block" },
  { marker: "color-scheme: light", what: "the semantic palette `:root` block" },
];

/** Every TOP-LEVEL `:root { … }` block (column 0 — a nested one inside `@layer` is not ours). */
function rootBlocks(css) {
  return [...css.matchAll(/^:root\s*\{/gm)].map((match) => ({
    start: match.index,
    body: blockAt(css, match.index, "a top-level `:root` block"),
  }));
}

/**
 * The app's PALETTE, verbatim, in the order the stylesheet declares it.
 *
 * WHY IT IS HERE. `theme.css` maps `--color-background: var(--background)`; in the app the
 * `--background` VALUE comes from the app's own document, and in the playground it can only come
 * from this file. Extracting it with the same script as the theme is what makes the pair
 * consistent: one read of `index.css` produces both, so a token cannot be renamed in one and not
 * the other.
 */
export function extractPluginPalette(css) {
  const roots = rootBlocks(css);
  const picked = [];
  for (const { marker, what } of PALETTE_BLOCKS) {
    const hits = roots.filter((root) => root.body.includes(marker));
    if (hits.length !== 1) {
      throw new Error(
        `gen-plugin-theme: expected exactly one top-level \`:root\` block containing ` +
          `\`${marker}\` (${what}), found ${String(hits.length)}`,
      );
    }
    picked.push(hits[0]);
  }
  // Document order, not marker order — the file is a verbatim copy of the app's cascade, and the
  // second block reads variables (`--sidebar-muted-foreground`) the first one mixes into a value.
  picked.sort((left, right) => left.start - right.start);
  return picked.map((root) => root.body).join("\n\n");
}

const header = (hash) => `/*
 * GENERATED by apps/web/src/ru-code/plugins/scripts/gen-plugin-theme.mjs — DO NOT EDIT BY HAND.
 *
 * THREE things from \`apps/web/src/index.css\`, verbatim and in this order:
 *
 *  1. \`@custom-variant dark (…)\` — the app switches themes with a CLASS, so without this a
 *     plugin's \`dark:\` utilities would key off \`prefers-color-scheme\` instead;
 *  2. the plain \`@theme { … }\` block — the \`--font-*\` tokens, declared outside the inline block
 *     on purpose so \`font-mono\` stays a \`var()\` the app's Appearance settings can override;
 *  3. the \`@theme inline { … }\` block — the token→variable mapping that turns a utility class into
 *     a rule against the app's own CSS variables, so a plugin's \`class="bg-background"\` follows the
 *     app's theme switch with no code of its own. With \`inline\`, Tailwind substitutes each token's
 *     VALUE into the utility instead of emitting \`var(--color-background)\`, so a plugin sheet
 *     references only the app's own \`--background\`-style variables and cannot carry a second copy
 *     of the palette.
 *
 * Used by \`pluginBuildConfig({ styles: { tailwind } })\` as the default theme. Re-run the script
 * (\`node apps/web/src/ru-code/plugins/scripts/gen-plugin-theme.mjs\`) whenever the app's block
 * changes; the SDK's \`tests/theme.test.ts\` and the app's \`pluginTheme.test.ts\` both check the
 * hash below.
 *
 * sha256: ${hash}
 */

`;

const paletteHeader = (hash) => `/*
 * GENERATED by apps/web/src/ru-code/plugins/scripts/gen-plugin-theme.mjs — DO NOT EDIT BY HAND.
 *
 * The app's PALETTE from \`apps/web/src/index.css\`, verbatim and in document order: the two
 * top-level \`:root { … }\` blocks — the compact-geometry one and the semantic palette — each with
 * its own \`@variant dark { … }\` arm, so both theme arms come from one source.
 *
 * WHY THIS FILE EXISTS, AND WHERE IT IS ALLOWED TO GO. \`tailwind/theme.css\` is the
 * \`@theme inline\` MAPPING — \`--color-background: var(--background)\` — and nothing else, because in
 * the real app the \`--background\`-style VALUES come from the app's own document and a plugin must
 * never carry a second copy of the palette (that is the whole point of \`inline\`). The PLAYGROUND
 * has no app document, so the values have to come from somewhere, and a harness that invented its
 * own would show the author a plugin that does not look like the product.
 *
 * So: the playground's stylesheet imports this file, and NOTHING ELSE DOES. \`pluginBuildConfig\`
 * does not, a plugin's \`dist/web/styles.css\` does not, and the SDK's \`exports\` map does not
 * publish it. It is a dev-time stand-in for the app's document.
 *
 * Re-run the script (\`node apps/web/src/ru-code/plugins/scripts/gen-plugin-theme.mjs\`) whenever
 * the app's \`:root\` blocks change; \`tests/playgroundPalette.test.ts\` re-hashes the body below
 * and also checks that it defines every custom property \`theme.css\` maps, so a token added to
 * the app's theme cannot leave the playground rendering \`var(--x)\` against nothing.
 *
 * sha256: ${hash}
 */

`;

/**
 * Every copy of one SDK tailwind file this checkout can see.
 *
 * The SOURCE first, when the gitignored `ru-code-packages` symlink is present (the same dev switch
 * `.pnpmfile.cjs` uses) — that is the file that is committed and published. The INSTALLED copy
 * second: pnpm's `file:` protocol HARD-LINKS, and writing through one path can leave the other
 * behind, so both are written and both are read back.
 *
 * The presence test is the tailwind DIRECTORY, not the file: a copy this script has never written
 * yet (the installed tree predates `palette.css`) is a target to CREATE, not one to skip.
 */
function sdkTailwindTargets(file) {
  const targets = [];
  const source = NodePath.resolve(
    repoRoot,
    `ru-code-packages/packages/plugin-sdk/tailwind/${file}`,
  );
  if (NodeFS.existsSync(NodePath.dirname(source))) targets.push(source);
  try {
    // `palette.css` is deliberately NOT in the SDK's `exports` map (a plugin bundle must never be
    // able to import it), so the installed directory is found through the file that IS exported.
    const installedTheme = NodeModule.createRequire(NodePath.resolve(webRoot, "noop.cjs")).resolve(
      "@smart-tools/plugin-sdk/tailwind/theme.css",
    );
    const installed = NodePath.join(NodePath.dirname(installedTheme), file);
    if (!targets.includes(installed)) targets.push(installed);
  } catch {
    // The SDK is not installed here (a checkout that never ran `pnpm install`). The source copy,
    // when present, is still the one that matters.
  }
  if (targets.length === 0) {
    throw new Error(`gen-plugin-theme: no @smart-tools/plugin-sdk tailwind/${file} to write`);
  }
  return targets;
}

export function pluginThemeTargets() {
  return sdkTailwindTargets("theme.css");
}

export function pluginPaletteTargets() {
  return sdkTailwindTargets("palette.css");
}

const css = NodeFS.readFileSync(INDEX_CSS, "utf8");

/** The two generated files, each = where it goes · what goes in it · the header that stamps it. */
const artefacts = [
  { what: "theme", targets: pluginThemeTargets(), body: extractPluginTheme(css), header },
  {
    what: "palette",
    targets: pluginPaletteTargets(),
    body: extractPluginPalette(css),
    header: paletteHeader,
  },
];

const checking = process.argv.includes("--check");
const stamps = [];
const stale = [];
const written = [];

for (const artefact of artefacts) {
  const hash = hashTheme(artefact.body);
  stamps.push(`${artefact.what} sha256 ${hash.slice(0, 12)}…`);
  const next = `${artefact.header(hash)}${artefact.body}\n`;
  for (const target of artefact.targets) {
    if (NodeFS.existsSync(target) && NodeFS.readFileSync(target, "utf8") === next) continue;
    if (checking) stale.push(target);
    else {
      NodeFS.writeFileSync(target, next, "utf8");
      written.push(target);
    }
  }
}

if (stale.length > 0) {
  console.error(
    `[gen-plugin-theme] STALE: ${stale.join(", ")}\n` +
      "Run `node apps/web/src/ru-code/plugins/scripts/gen-plugin-theme.mjs` and commit the SDK files.",
  );
  process.exit(1);
} else if (written.length === 0) {
  console.log(`[gen-plugin-theme] up to date (${stamps.join(", ")})`);
} else {
  console.log(
    `[gen-plugin-theme] wrote ${String(written.length)} file(s) (${stamps.join(", ")}): ` +
      written.join(", "),
  );
}
