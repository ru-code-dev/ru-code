// Build-time localization transform (Vite/Rollup plugin).
//
// For each module that has dictionary entries scoped to it, parse it once, place the
// entries onto its display nodes, and splice each into a call to the runtime helper —
// inlining BOTH the English original and the Russian translation. The disk source is
// never mutated; the Russian exists only in the built bundle (and in the dict JSON).
//
// Locating happens HERE, per file (not in a whole-tree pre-pass), so it is naturally
// incremental — dev HMR re-localizes only the edited file, and offsets are always fresh
// (no stale catalog). Files with no dictionary entries return in O(1) without parsing.
// `enforce: "pre"` so we see raw source before other transforms.

import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import { loadDictionaryByScope, placeEntries } from "./locate.mjs";
import { failOnLocalizationError } from "./strict.mjs";
import { runCompareGuard, report as reportCompareGuard } from "./compareGuard.mjs";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../..", import.meta.url)));

// Compare-guard runs once per process (both the web and server plugin instances share
// this module scope): fail the build if any translated string is compared/parsed.
let compareGuardChecked = false;

const L_IMPORT_NAME = "__ruL";
const LT_IMPORT_NAME = "__ruLT";
// ru-code: wire-token emitter for server-emitted display strings (resolved in the viewer's
// locale on the web, not at the server's emit locale). See ../src/serverToken.ts.
const LC_IMPORT_NAME = "__ruLc";

function renderFile(code, units) {
  const used = { L: false, LT: false, Lc: false };

  // Units within [from, to), rendered left-to-right; a unit that contains others (a
  // template with translated interpolations) renders its inner units by recursing over
  // each expression sub-range.
  const renderRange = (from, to) => {
    const inRange = units.filter((u) => u.start >= from && u.end <= to);
    const topLevel = inRange.filter(
      (u) =>
        !inRange.some(
          (v) =>
            v !== u &&
            v.start <= u.start &&
            v.end >= u.end &&
            !(v.start === u.start && v.end === u.end),
        ),
    );
    topLevel.sort((a, b) => a.start - b.start);
    let out = "";
    let cursor = from;
    for (const u of topLevel) {
      out += code.slice(cursor, u.start);
      out += renderUnit(u);
      cursor = u.end;
    }
    out += code.slice(cursor, to);
    return out;
  };

  const renderUnit = (u) => {
    const en = JSON.stringify(u.en);
    const ru = JSON.stringify(u.ru);
    // ru-code: wire entries emit Lc(en, ru, ...args) — a locale-independent token resolved on
    // the web. Interpolation args ride as varargs (not the LT array), so the token carries them.
    if (u.wire) {
      used.Lc = true;
      const args = u.kind === "tpl" ? (u.exprs || []).map(([s, e]) => renderRange(s, e)) : [];
      const call = `${LC_IMPORT_NAME}(${[en, ru, ...args].join(", ")})`;
      if (u.kind === "jsx" || u.braces) return `{${call}}`;
      return call;
    }
    if (u.kind === "tpl") {
      used.LT = true;
      const exprs = (u.exprs || []).map(([s, e]) => renderRange(s, e)).join(", ");
      return `${LT_IMPORT_NAME}(${en}, ${ru}, [${exprs}])`;
    }
    used.L = true;
    const call = `${L_IMPORT_NAME}(${en}, ${ru})`;
    if (u.kind === "jsx" || u.braces) return `{${call}}`;
    return call;
  };

  const body = renderRange(0, code.length);
  return { body, used };
}

function prependImport(code, used) {
  const names = [];
  if (used.L) names.push(`L as ${L_IMPORT_NAME}`);
  if (used.LT) names.push(`LT as ${LT_IMPORT_NAME}`);
  if (used.Lc) names.push(`Lc as ${LC_IMPORT_NAME}`); // ru-code: wire-token emitter
  if (names.length === 0) return code;
  const importLine = `import { ${names.join(", ")} } from "@ru-code/localization";\n`;
  // Preserve a leading shebang if present (bin entry files).
  if (code.startsWith("#!")) {
    const nl = code.indexOf("\n");
    return code.slice(0, nl + 1) + importLine + code.slice(nl + 1);
  }
  return importLine + code;
}

export function ruCodeLocalizationPlugin() {
  const dictByScope = loadDictionaryByScope();
  const cache = new Map(); // content hash -> transform result (per-process)
  // Per-build bookkeeping for the PER-TRANSLATION gate in generateBundle below.
  //  • `seen`         — every dict-scoped file the transform actually processed.
  //  • `leftoverByRel`— per file, the dict entries that DID NOT place onto a current source
  //                     node (reworded/removed/mis-scoped). Each is a translation that ships
  //                     English. `[]` means every entry for that file was applied.
  const seen = new Set();
  const leftoverByRel = new Map();

  const relOf = (id) =>
    NodePath.relative(REPO_ROOT, id.split("?")[0]).split(NodePath.sep).join("/");

  return {
    name: "ru-code-localization",
    enforce: "pre",
    buildStart() {
      if (compareGuardChecked) return;
      compareGuardChecked = true;
      const result = runCompareGuard();
      if (result.active.length > 0) {
        const message =
          "ru-code localization compare-guard failed — a translated string is compared/parsed as a key.\n" +
          "Fix the comparison to use a stable key, or record a decision in " +
          "ru-code/localization/dict/compare-allowlist.txt.\n\n" +
          reportCompareGuard(result);
        // Same strict switch as the placement gate: hard-fail only on the finished fork
        // (branding applied, FAIL_ON_LOCALIZATION_ERROR = true). Mid-resync the guard's seam
        // fixes may not be replayed yet — report, don't break intermediate builds.
        if (failOnLocalizationError()) {
          throw new Error(message);
        }
        this.warn(
          `${message}\n(FAIL_ON_LOCALIZATION_ERROR is not set — reporting only, build continues.)`,
        );
      }
    },
    transform(code, id) {
      const clean = id.split("?")[0];
      if (clean.startsWith("\0") || !/\.(ts|tsx|js|jsx)$/.test(clean)) return null;
      const rel = clean.startsWith(REPO_ROOT) ? relOf(clean) : null;
      const entries = rel && dictByScope.get(rel);
      if (!entries || entries.length === 0) return null; // O(1) skip — most files
      seen.add(rel);

      const key = NodeCrypto.createHash("sha1").update(rel).update("\0").update(code).digest("hex");
      if (cache.has(key)) return cache.get(key);

      let result = null;
      try {
        const { units, leftover } = placeEntries(code, rel, entries); // parses THIS file, fresh offsets
        // Record which of THIS file's entries did not land. Zero leftover ⇒ every entry was
        // placed and rendered as L(en, ru) — so the Russian is in the emitted code by
        // construction (the bundler only drops dead code, never a live call).
        leftoverByRel.set(rel, leftover);
        if (units.length > 0) {
          const { body, used } = renderFile(code, units);
          result = { code: prependImport(body, used), map: null };
        }
      } catch (error) {
        // Parse failure ⇒ nothing placed; treat every entry as unapplied so the gate reports it.
        leftoverByRel.set(rel, entries);
        this.warn(`ru-code-localization: failed to localize ${rel} (${error}) — left English`);
        result = null;
      }
      cache.set(key, result);
      return result;
    },

    // ── Per-translation build gate — the guarantee, not luck ──────────────────────────────
    // For every dictionary-scoped file that actually made it into the OUTPUT (survived tree-
    // shaking; dead code never enters `chunk.modules`), assert that EVERY one of its dictionary
    // entries was applied. Two ways an entry fails to apply, both fatal and both reported:
    //   1. the transform never ran on the file  → wrong bundler wiring / path mismatch;
    //   2. the transform ran but the entry did not match a source node (leftover) → the string
    //      was reworded/removed/mis-scoped, so English ships for that one line.
    // ALL failures across the whole build are collected and reported together. Runs under both
    // Vite (web) and `vp pack`/rolldown (server), so every shipping bundle is covered.
    generateBundle(_outputOptions, bundle) {
      const bundledRels = new Set();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk" || !chunk.modules) continue;
        for (const moduleId of Object.keys(chunk.modules)) {
          const clean = moduleId.split("?")[0];
          if (!clean.startsWith(REPO_ROOT)) continue;
          const rel = relOf(clean);
          if (dictByScope.has(rel)) bundledRels.add(rel);
        }
      }

      const failures = [];
      for (const rel of [...bundledRels].sort()) {
        if (!seen.has(rel)) {
          const count = dictByScope.get(rel).length;
          failures.push(`${rel} — transform never ran; all ${count} translation(s) ship English`);
          continue;
        }
        for (const entry of leftoverByRel.get(rel) ?? []) {
          failures.push(
            `${rel} :: ${JSON.stringify(entry.en)} → ${JSON.stringify(entry.ru)} — no matching source string, English ships`,
          );
        }
      }

      if (failures.length > 0) {
        const report =
          `ru-code-localization: ${failures.length} translation(s) shipped WITHOUT being applied ` +
          `(per-string check over ${bundledRels.size} bundled localized file(s)):\n` +
          failures.map((f) => `  • ${f}`).join("\n") +
          `\nEach line is a dictionary entry whose Russian did not reach the bundle. Fix the entry's ` +
          `"en"/"scope" to match the current source, or delete it if the string is gone.`;
        // Strict only when @ru-code/branding sets FAIL_ON_LOCALIZATION_ERROR = true (the finished
        // fork). Mid-resync — branding not yet applied, dictionary overshoots the partial source —
        // this reads lenient, so we report the gaps but don't break the intermediate build.
        if (failOnLocalizationError()) {
          this.error(report);
        } else {
          this.warn(
            `${report}\n(FAIL_ON_LOCALIZATION_ERROR is not set — reporting only, build continues.)`,
          );
        }
      }
    },
  };
}
