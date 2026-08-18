// Build the localization catalog by locating dictionary.json entries in the current tree,
// and report anything that couldn't be placed. This is the build step (regenerated every
// build) AND the drift gate (`localize:check`, run with --strict after an upstream sync).
//
//   pnpm localize:catalog   → build the catalog (lenient: warns on drift)
//   pnpm localize:check      → same + exit non-zero if anything is UNLOCATED / AMBIGUOUS

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { buildCatalog, DICT_DIR } from "./locate.mjs";
import { lintDictionary } from "./dictLint.mjs";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../..", import.meta.url)));
const CATALOG_PATH = NodePath.join(REPO_ROOT, "ru-code/localization/build/catalog.generated.json");
const strict = process.argv.includes("--strict");
const fix = process.argv.includes("--fix");

const dictFile = (scope) => NodePath.join(DICT_DIR, ...scope.split("/")) + ".json";
const readDict = (scope) => {
  try {
    return JSON.parse(NodeFS.readFileSync(dictFile(scope), "utf8"));
  } catch {
    return [];
  }
};
const writeDict = (scope, arr) => {
  arr.sort((a, b) => a.en.localeCompare(b.en) || (a.nth ?? 0) - (b.nth ?? 0));
  const f = dictFile(scope);
  NodeFS.mkdirSync(NodePath.dirname(f), { recursive: true });
  if (arr.length) NodeFS.writeFileSync(f, JSON.stringify(arr, null, 2) + "\n");
  else NodeFS.rmSync(f, { force: true });
};
const sameEntry = (a, b) =>
  a.en === b.en && a.kind === b.kind && a.ru === b.ru && (a.nth ?? null) === (b.nth ?? null);

let { catalog, report } = buildCatalog();

// --fix: auto-relocate MOVED entries (safe — they already land at the new file). This is
// the only category that can be resolved without a human decision.
if (fix && report.moved.length) {
  const byFrom = new Map();
  for (const m of report.moved) {
    if (!byFrom.has(m.from)) byFrom.set(m.from, []);
    byFrom.get(m.from).push(m);
  }
  for (const [from, moves] of byFrom) {
    let src = readDict(from);
    for (const m of moves) {
      const { scope: _drop, ...bare } = m.entry;
      src = src.filter((e) => !sameEntry(e, m.entry));
      const dst = readDict(m.to);
      if (!dst.some((e) => sameEntry(e, bare))) dst.push(bare);
      writeDict(m.to, dst);
    }
    writeDict(from, src);
  }
  console.log(
    `--fix: relocated ${report.moved.length} moved entr${report.moved.length === 1 ? "y" : "ies"}. Re-checking…\n`,
  );
  ({ catalog, report } = buildCatalog());
}

NodeFS.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 0) + "\n");

const files = Object.keys(catalog).length;
console.log(`localization catalog: ${report.located} strings placed across ${files} files`);

if (report.moved.length) {
  console.log(
    `\nMOVED (${report.moved.length}) — still applied at the new location; update "scope" in dictionary.json:`,
  );
  for (const m of report.moved.slice(0, 40)) {
    console.log(`  ${JSON.stringify(m.en).slice(0, 60)}  ${m.from}  →  ${m.to}`);
  }
}
if (report.ambiguous.length) {
  console.log(
    `\nAMBIGUOUS (${report.ambiguous.length}) — same string in several files, can't choose; add/fix "scope":`,
  );
  for (const a of report.ambiguous.slice(0, 40)) {
    console.log(
      `  ${JSON.stringify(a.en).slice(0, 60)}  scope=${a.scope}  candidates: ${a.files.join(", ")}`,
    );
  }
}
if (report.unlocated.length) {
  console.log(
    `\nUNLOCATED (${report.unlocated.length}) — English gone from its file (reworded/removed). Action: update the`,
  );
  console.log(
    `  entry's "en"/"scope" to match upstream, or delete it. The site shows English until fixed:`,
  );
  for (const u of report.unlocated.slice(0, 80)) {
    console.log(
      `  ${u.scope}:  ${JSON.stringify(u.en).slice(0, 70)}  →  ${JSON.stringify(u.ru).slice(0, 40)}`,
    );
  }
}

// Dictionary integrity — deterministic corruption gate (alignment-slip fingerprints).
const { errors: lintErrors, warnings: lintWarnings } = lintDictionary();
if (lintWarnings.length) {
  console.log(
    `\nDICT WARNINGS (${lintWarnings.length}) — one Russian shared by several English strings;` +
      ` usually legitimate synonyms, confirm none is a hidden mispair:`,
  );
  for (const w of lintWarnings.slice(0, 60)) console.log(`  ${w}`);
}
if (lintErrors.length) {
  console.error(`\n✗ DICT INTEGRITY (${lintErrors.length}) — corrupt entries (bad en↔ru pairing):`);
  for (const e of lintErrors) console.error(`  ${e}`);
}

const problems = report.unlocated.length + report.ambiguous.length + lintErrors.length;
if (report.moved.length === 0 && problems === 0) {
  console.log("✅ every dictionary entry placed cleanly and passed the integrity gate.");
}
if (strict && problems > 0) {
  console.error(`\n✗ ${problems} issue(s) need attention (see above). Failing (--strict).`);
  process.exit(1);
}
