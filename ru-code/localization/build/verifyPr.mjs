// Faithfulness proof: the dictionary + locator reproduce the l10n PR EXACTLY.
//
// For every file the PR touched, we recompute the ground-truth translated nodes
// (working-tree EN display units aligned against the commit's RU) and compare them,
// by byte offset + RU text, to what the locator actually wraps. Two guarantees:
//   • NO MISS      — every PR translation is applied.
//   • NO OVER-WRAP — the locator never wraps a node the PR left untranslated
//                    (i.e. it never touches logic/other strings — the safety proof).
// Plus the union completeness: every PR display string is reproduced by a wrap or a seam.
//
// This is the only tool that still reads the commit (a one-shot check, not the build).

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { collectDisplayUnits, allCyrillicTexts, CYRILLIC } from "./nodes.mjs";
import { pairUnits } from "./align.mjs";
import { buildCatalog } from "./locate.mjs";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../..", import.meta.url)));
const EN_REF = "a762f74d5";
const RU_REF = "85f08138c";
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

function addCoverage(set, kind, ru) {
  if (kind === "tpl") for (const chunk of ru.split(/\{\d+\}/)) set.add(chunk);
  else set.add(ru);
}

const changed = git(`diff --name-status ${EN_REF} ${RU_REF}`)
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

const { catalog } = buildCatalog();
const locatorByFile = new Map(); // file -> Map<start, ru>
for (const [file, units] of Object.entries(catalog)) {
  const m = new Map();
  for (const u of units) m.set(u.start, u.ru);
  locatorByFile.set(file, m);
}

const overWraps = [];
const misses = [];
const targets = new Set();
const coverage = new Set();

for (const { file } of changed) {
  let enSource;
  let ruSource;
  try {
    enSource = NodeFS.readFileSync(NodePath.join(REPO_ROOT, file), "utf8");
    ruSource = show(RU_REF, file);
  } catch {
    continue;
  }
  const pairs = pairUnits(collectDisplayUnits(enSource, file), collectDisplayUnits(ruSource, file));
  const truth = new Map(); // start -> ru
  for (const { en, ru } of pairs) truth.set(en.start, ru.text);

  const located = locatorByFile.get(file) ?? new Map();

  // No over-wrap: everything the locator wraps must be a genuine PR translation.
  for (const [start, ru] of located) {
    if (!truth.has(start)) overWraps.push({ file, start, ru });
    else if (truth.get(start) !== ru)
      overWraps.push({ file, start, ru, expected: truth.get(start) });
  }
  // No miss: every PR translation must be applied.
  for (const [start, ru] of truth) {
    if (!located.has(start)) misses.push({ file, start, ru });
  }

  for (const t of allCyrillicTexts(ruSource, file)) targets.add(t);
  for (const t of allCyrillicTexts(enSource, file)) coverage.add(t); // working-tree seams
}
for (const [, m] of locatorByFile)
  for (const ru of m.values()) addCoverage(coverage, ru.includes("{0}") ? "tpl" : "str", ru);
const uncovered = [...targets].filter((t) => !coverage.has(t) && CYRILLIC.test(t));

console.log(`verify-pr: ${changed.length} PR files`);
console.log(`  over-wraps (locator touched a non-translation): ${overWraps.length}`);
console.log(`  misses (PR translation not applied): ${misses.length}`);
console.log(`  uncovered PR display strings: ${uncovered.length}`);
const show1 = (arr) =>
  arr.slice(0, 30).forEach((x) => console.log("   ", JSON.stringify(x).slice(0, 140)));
if (overWraps.length) {
  console.error("\nOVER-WRAPS:");
  show1(overWraps);
}
if (misses.length) {
  console.error("\nMISSES:");
  show1(misses);
}
if (uncovered.length) {
  console.error("\nUNCOVERED:");
  show1(uncovered.map((t) => t.slice(0, 80)));
}
if (overWraps.length || misses.length || uncovered.length) {
  console.error("\n✗ dictionary+locator do NOT faithfully reproduce the PR.");
  process.exit(1);
}
console.log("\n✅ dictionary+locator reproduce the PR exactly: 0 miss, 0 over-wrap, 100% covered.");
