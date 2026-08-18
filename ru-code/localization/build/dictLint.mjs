// Deterministic dictionary-integrity gate.
//
// The dict was bootstrapped ONCE by aligning the English base against the Russian PR
// (`pairUnits`). Where the two node-lists differ in count — a fork-added region such as the
// Settings→Язык picker, which sits next to the timestamp-format seam — the alignment can slip
// and pair a code-value/endonym with an unrelated translation (`en:"en" → ru:"24-часовой"`).
// These checks make that CLASS impossible to ship: they run in `localize:check` and (gated by
// FAIL_ON_LOCALIZATION_ERROR) in the build. They are deterministic — no LLM, no network.
//
// They do NOT catch an ARBITRARY mispair of two otherwise-valid display strings (only a
// semantic judge can); they catch the fingerprints an alignment slip leaves behind:
//   1. `en` contains Cyrillic                → an endonym/label ("Русский") got treated as a
//                                              source string. English is Latin by definition.
//   2. `en === ru`                            → not a translation.
//   3. `en` is a code discriminant  AND       → a fork-added value ("en","ru") got aligned onto
//      `ru` duplicates an inline-seam           an adjacent seam's Russian ("24-часовой"). The
//                                              conjunction is exact: it fires ONLY on this slip,
//                                              never on a discriminant that is also legitimately
//                                              displayed ("server"→"сервер": ru isn't a seam)
//                                              nor on a normal word sharing a seam's Russian
//                                              ("Working"→"Работает": en isn't a discriminant).
// `same ru ← several en` is surfaced as a WARNING (synonyms legitimately collapse), not fatal.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { loadDictionary, sourceFiles } from "./locate.mjs";
import { allCyrillicTexts, CYRILLIC } from "./nodes.mjs";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../..", import.meta.url)));

// String members of `Schema.Literals([...])` and `type X = "a" | "b"` unions across source —
// these are code discriminants. A dictionary `en` equal to one is never a display string.
function collectCodeDiscriminants() {
  const members = new Set();
  for (const abs of sourceFiles()) {
    let src;
    try {
      src = NodeFS.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(/Schema\.Literals\(\[([^\]]*)\]/g)) {
      for (const s of m[1].matchAll(/"([^"]*)"|'([^']*)'/g)) members.add(s[1] ?? s[2]);
    }
    // `= "a" | "b" | …` (two or more string-literal members) — a string union type.
    for (const m of src.matchAll(/=\s*("[^"]*"(?:\s*\|\s*"[^"]*")+)/g)) {
      for (const s of m[1].matchAll(/"([^"]*)"/g)) members.add(s[1]);
    }
  }
  return members;
}

// Every hardcoded Cyrillic string in source is an inline SEAM's Russian (the only place the
// fork writes Russian into source). Used to detect a dict `ru` that mis-paired onto a seam.
function collectSeamRu() {
  const seams = new Set();
  for (const abs of sourceFiles()) {
    let src;
    try {
      src = NodeFS.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const rel = NodePath.relative(REPO_ROOT, abs).split(NodePath.sep).join("/");
    for (const t of allCyrillicTexts(src, rel)) seams.add(t);
  }
  return seams;
}

export function lintDictionary() {
  const entries = loadDictionary();
  const discriminants = collectCodeDiscriminants();
  const seamRu = collectSeamRu();
  const errors = [];
  const warnings = [];
  const ruToEns = new Map();

  for (const e of entries) {
    const at = `${e.scope} :: ${JSON.stringify(e.en)} → ${JSON.stringify(e.ru)}`;
    if (CYRILLIC.test(e.en))
      errors.push(`en contains Cyrillic (English field must be Latin) — ${at}`);
    if (e.en === e.ru) errors.push(`en === ru (no-op translation) — ${at}`);
    if (discriminants.has(e.en) && seamRu.has(e.ru)) {
      errors.push(
        `code discriminant paired with a seam's Russian (alignment-slip fingerprint) — ${at}`,
      );
    }
    if (!ruToEns.has(e.ru)) ruToEns.set(e.ru, new Set());
    ruToEns.get(e.ru).add(e.en);
  }

  for (const [ru, ens] of ruToEns) {
    if (ens.size > 1 && CYRILLIC.test(ru)) {
      warnings.push(
        `same ru ${JSON.stringify(ru)} ← [${[...ens].map((x) => JSON.stringify(x)).join(", ")}]`,
      );
    }
  }
  return { errors, warnings };
}
