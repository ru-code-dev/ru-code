// ONE-TIME bootstrap: extract the checked-in translation dictionary from the l10n PR.
//
// Reads the PR (working-tree EN, which carries our hand seams, vs RU 85f08138c), pairs
// the display units, and writes dictionary.json — the SINGLE SOURCE OF TRUTH from here
// on. After running this, no build tooling references the commit again; the dictionary
// is hand-editable (add / fix / move / remove) and validated by verifyPr.mjs.
//
// Faithful duplicates: we compare ALL English occurrences of a (kind, en) against which
// ones the PR translated. All → same RU ⇒ one "apply to all" entry (move-tolerant).
// A subset, or several RUs ⇒ per-occurrence `nth` entries, so we reproduce the PR exactly
// and never touch an occurrence it left in English.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { collectDisplayUnits, allCyrillicTexts, CYRILLIC } from "./nodes.mjs";
import { pairUnits } from "./align.mjs";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../..", import.meta.url)));
const RU_REF = "85f08138c";
const DICT_DIR = NodePath.join(REPO_ROOT, "ru-code/localization/dict");

const git = (args) =>
  NodeChildProcess.execSync(`git ${args}`, {
    cwd: REPO_ROOT,
    maxBuffer: 1 << 30,
    encoding: "utf8",
  });
const show = (ref, p) =>
  NodeChildProcess.execSync(`git show ${ref}:"${p}"`, {
    cwd: REPO_ROOT,
    maxBuffer: 1 << 30,
    encoding: "utf8",
  });

// A translation's RU covers the same node texts `allCyrillicTexts` sees: a plain string
// is itself; a template skeleton decomposes into its chunk texts (split on {n}).
function addCoverage(set, kind, ru) {
  if (kind === "tpl") for (const chunk of ru.split(/\{\d+\}/)) set.add(chunk);
  else set.add(ru);
}

const changed = git(`diff --name-status a762f74d5 ${RU_REF}`)
  .trim()
  .split("\n")
  .map((line) => {
    const [status, ...rest] = line.split("\t");
    return { status, file: rest.join("\t") };
  })
  .filter(
    (c) =>
      c.status.startsWith("M") && /\.(ts|tsx)$/.test(c.file) && !/\.test\.[tj]sx?$/.test(c.file),
  );

const entries = [];
const conflicts = [];
const coverage = new Set(); // dictionary RU + working-tree seam RU
const targets = new Set(); // every Cyrillic display string in the PR

for (const { file } of changed) {
  let enSource;
  let ruSource;
  try {
    enSource = NodeFS.readFileSync(NodePath.join(REPO_ROOT, file), "utf8");
    ruSource = show(RU_REF, file);
  } catch {
    continue;
  }
  const enUnits = collectDisplayUnits(enSource, file);
  const pairs = pairUnits(enUnits, collectDisplayUnits(ruSource, file));

  for (const t of allCyrillicTexts(ruSource, file)) targets.add(t);
  for (const t of allCyrillicTexts(enSource, file)) coverage.add(t); // seams inlined in the tree

  const ruByStart = new Map();
  for (const { en, ru } of pairs) ruByStart.set(en.start, ru.text);
  const occByKey = new Map();
  for (const u of enUnits) {
    const gk = u.kind + " " + u.text;
    if (!occByKey.has(gk)) occByKey.set(gk, []);
    occByKey.get(gk).push(u);
  }
  for (const occ of occByKey.values()) {
    const translated = occ
      .map((u, i) => ({ i, ru: ruByStart.get(u.start) }))
      .filter((x) => x.ru !== undefined);
    if (translated.length === 0) continue;
    const kind = occ[0].kind;
    const en = occ[0].text;
    const distinctRu = new Set(translated.map((t) => t.ru));
    if (translated.length === occ.length && distinctRu.size === 1) {
      entries.push({ en, ru: translated[0].ru, kind, scope: file });
      addCoverage(coverage, kind, translated[0].ru);
    } else {
      if (distinctRu.size > 1) conflicts.push({ file, en, variants: [...distinctRu] });
      for (const t of translated) {
        entries.push({ en, ru: t.ru, kind, scope: file, nth: t.i });
        addCoverage(coverage, kind, t.ru);
      }
    }
  }
}

// Write one JSON per source file, mirroring the repo tree; the path carries the scope,
// so the files omit it. This bootstrap regenerates the whole tree from the PR.
const byScope = new Map();
for (const e of entries) {
  if (!byScope.has(e.scope)) byScope.set(e.scope, []);
  const { scope, ...rest } = e;
  byScope.get(scope).push(rest);
}
NodeFS.rmSync(DICT_DIR, { recursive: true, force: true });
for (const [scope, arr] of byScope) {
  arr.sort((a, b) => a.en.localeCompare(b.en) || (a.nth ?? 0) - (b.nth ?? 0));
  const file = NodePath.join(DICT_DIR, ...scope.split("/")) + ".json";
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, JSON.stringify(arr, null, 2) + "\n");
}

const missed = [...targets].filter((t) => !coverage.has(t) && CYRILLIC.test(t));
console.log(
  `dictionary: ${entries.length} entries across ${new Set(entries.map((e) => e.scope)).size} files`,
);
console.log(
  `nth-indexed entries (duplicates/subsets): ${entries.filter((e) => e.nth != null).length}`,
);
console.log(`conflicts (same en → multiple ru): ${conflicts.length}`);
for (const c of conflicts.slice(0, 20))
  console.log(`  ${c.file}: ${JSON.stringify(c.en)} → ${c.variants.length} variants`);
console.log(
  `PR completeness: ${targets.size} display strings, ${targets.size - missed.length} covered, ${missed.length} missed`,
);
if (missed.length) {
  console.error(`\nMISSED FROM PR (${missed.length}):`);
  for (const m of missed.slice(0, 60)) console.error(`  ${JSON.stringify(m).slice(0, 100)}`);
  process.exit(1);
}
console.log(
  `✅ dictionary reproduces 100% of the PR (with the seams). Wrote ${byScope.size} files under ${DICT_DIR}`,
);
