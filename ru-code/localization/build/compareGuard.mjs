// ru-code: localization COMPARE-GUARD.
//
// Invariant it enforces: a translated (dictionary) string must never sit in a
// comparison / parse / key position — `===` `!==` `==` `!=`, `switch`-`case`,
// member-access `obj["k"]`, or the string methods `includes/startsWith/endsWith/
// indexOf/search/match/has/get/set/delete`. If it does, translating that string
// silently changes program BEHAVIOUR when the locale flips (the DiffPanel bug).
//
// It is GLOBAL, not per-file: every dict value (en+ru) is loaded into one set and
// checked against every comparison site in apps/ + packages/. A hash lookup per
// literal — piggybacks the pass the transform already runs, so effectively free.
//
// Fail-closed. Every violation must be resolved by either (a) fixing the site to
// compare a stable key, or (b) recording a one-line decision in compare-allowlist.txt,
// keyed by `file | expression` (NOT line number — line numbers drift). A safe collision
// (`routeKind === "server"`) is allowlisted; a real bug (`label === "Commit"`) is fixed.
//
// Runnable standalone (`node build/compareGuard.mjs`) with zero deps, and wired into
// the Vite plugin's buildStart so real builds go red.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Self-contained: reads dict JSON directly (NOT via locate.mjs, whose transitive import
// of nodes.mjs pulls in `typescript`) so the guard runs with zero deps in a fresh worktree.
const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../..", import.meta.url)));
const DICT_DIR = NodePath.join(REPO_ROOT, "ru-code/localization/dict");
// Lives inside dict/ so it is persisted with the translations (loadDictionary reads only *.json,
// so it ignores this .txt).
const ALLOWLIST_PATH = NodePath.resolve(
  NodeURL.fileURLToPath(new URL("../dict/compare-allowlist.txt", import.meta.url)),
);
const SCAN_ROOTS = ["apps", "packages"];
// apps the localization transform never covers → their comparisons are not against
// dict-translated values, so they are never guard violations. Mirrors locate.mjs.
const EXCLUDE_PREFIXES = ["apps/mobile/", "apps/desktop/"];

// CSS/DOM/layout keywords collide with dict words (e.g. "left" vs "осталось") but are
// never localized display text in a comparison. Structurally excluded (not allowlisted).
const CSS_DENYLIST = new Set([
  "left",
  "right",
  "top",
  "bottom",
  "center",
  "middle",
  "start",
  "end",
  "auto",
  "none",
  "inherit",
  "row",
  "column",
  "horizontal",
  "vertical",
]);
const KEY_METHODS = new Set(["has", "get", "set", "delete"]);
const SUBSTR_METHODS = new Set([
  "includes",
  "indexOf",
  "search",
  "match",
  "startsWith",
  "endsWith",
]);

// A "phrase" (natural-language, never a coincidental enum) → treat as almost-certainly real.
const isPhrase = (s) => /\s/.test(s.trim()) || /[.:…!?]/.test(s) || s.length >= 13;

// ---- dict universe ---------------------------------------------------------
// The dictionary is one JSON file per localized source file, mirroring the repo tree
// under dict/. The path IS the `scope` (same convention as locate.mjs.loadDictionary).
function loadDictUniverse() {
  const exact = new Map(); // value -> { scope, en, ru, kind }
  const phrases = []; // { value, info } for substring scanning
  const walk = (abs) => {
    let dirents;
    try {
      dirents = NodeFS.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const p = NodePath.join(abs, d.name);
      if (d.isDirectory()) {
        walk(p);
        continue;
      }
      if (!d.name.endsWith(".json")) continue;
      const scope = NodePath.relative(DICT_DIR, p)
        .split(NodePath.sep)
        .join("/")
        .replace(/\.json$/, "");
      let entries;
      try {
        entries = JSON.parse(NodeFS.readFileSync(p, "utf8"));
      } catch {
        continue;
      }
      for (const entry of entries) {
        for (const side of ["en", "ru"]) {
          const value = entry[side];
          if (typeof value !== "string" || value.length === 0) continue;
          const info = { scope, en: entry.en, ru: entry.ru, kind: entry.kind };
          if (!exact.has(value)) exact.set(value, info);
          if (value.length >= 8) phrases.push({ value, info });
        }
      }
    }
  };
  walk(DICT_DIR);
  return { exact, phrases };
}

// ---- allowlist (keyed by `relpath | normalized-expression`) ----------------
const normalizeExpr = (expr) => expr.replace(/\s+/g, " ").trim();
function loadAllowlist() {
  const allow = new Set();
  if (!NodeFS.existsSync(ALLOWLIST_PATH)) return allow;
  for (const raw of NodeFS.readFileSync(ALLOWLIST_PATH, "utf8").split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [rel, expr] = line.split("|");
    if (rel && expr) allow.add(`${rel.trim()} | ${normalizeExpr(expr)}`);
  }
  return allow;
}

// ---- source walk -----------------------------------------------------------
function collectSourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const name of NodeFS.readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === ".git" || name === "_generated")
        continue;
      const p = NodePath.join(dir, name);
      const st = NodeFS.statSync(p);
      const rel = NodePath.relative(REPO_ROOT, p).split(NodePath.sep).join("/");
      // Skip apps the transform never localizes (mobile/desktop) — comparisons there
      // are not against dict-translated values, so they are not guard violations.
      if (EXCLUDE_PREFIXES.some((prefix) => rel.startsWith(prefix) || `${rel}/`.startsWith(prefix)))
        continue;
      if (st.isDirectory()) walk(p);
      else if (
        [".ts", ".tsx", ".mts", ".cts"].includes(NodePath.extname(name)) &&
        !name.endsWith(".d.ts") &&
        !name.endsWith(".gen.ts")
      )
        files.push(p);
    }
  };
  for (const root of SCAN_ROOTS) {
    const abs = NodePath.join(REPO_ROOT, root);
    if (NodeFS.existsSync(abs)) walk(abs);
  }
  return files;
}

// Single-line quote scanner (handles \" \' escapes). No backtracking.
function literalsOnLine(line) {
  const out = [];
  for (const quote of ['"', "'", "`"]) {
    let i = 0;
    while (i < line.length) {
      if (line[i] !== quote) {
        i++;
        continue;
      }
      const start = i;
      i++;
      let buf = "";
      while (i < line.length && line[i] !== quote) {
        if (line[i] === "\\" && i + 1 < line.length) {
          buf += line[i + 1] === "n" ? "\n" : line[i + 1];
          i += 2;
        } else {
          buf += line[i];
          i++;
        }
      }
      if (i < line.length) {
        out.push({ value: buf, start, end: i + 1 });
        i++;
      } else break;
    }
  }
  return out;
}

// Classify the position of a literal and build a stable expression key.
function classify(before, after, literal) {
  const q = JSON.stringify(literal);
  let m;
  // Identifier chains only (member/optional-chain/index) — NOT crossing "(" or ")", so the
  // key is the minimal operand and identical comparisons collapse to ONE allowlist entry.
  if ((m = /([\w$][\w$.?[\]]*?)\s*(===|!==|==|!=)\s*$/.exec(before)))
    return { position: "eq", expr: `${m[1]} ${m[2]} ${q}` };
  if (/(===|!==|==|!=)\s*$/.test(before))
    return { position: "eq", expr: `${before.match(/(===|!==|==|!=)\s*$/)[1]} ${q}` };
  if (/^\s*(===|!==|==|!=)/.test(after))
    return { position: "eq", expr: `${q} ${after.trim().match(/^(===|!==|==|!=)/)[1]}` };
  if ((m = /([\w$][\w$.?[\]]*?)?\.(\w+)\(\s*$/.exec(before))) {
    const method = m[2];
    if (SUBSTR_METHODS.has(method) || KEY_METHODS.has(method))
      return { position: method, expr: `${m[1] ?? ""}.${method}(${q})` };
  }
  if (/\bcase\s*$/.test(before)) return { position: "case", expr: `case ${q}` };
  if ((m = /([\w$][\w$.?[\]]*?)\[\s*$/.exec(before)) && /^\s*\]/.test(after))
    return { position: "bracket-key", expr: `${m[1]}[${q}]` };
  return null;
}

export function runCompareGuard() {
  const { exact, phrases } = loadDictUniverse();
  const allow = loadAllowlist();
  const files = collectSourceFiles();
  const violations = [];

  for (const file of files) {
    let src;
    try {
      src = NodeFS.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = NodePath.relative(REPO_ROOT, file);
    const isTest = /\.test\.|(^|\/)tests?\//.test(rel);
    if (isTest) continue;
    const lines = src.split("\n");
    for (let ln = 0; ln < lines.length; ln++) {
      const line = lines[ln];
      if (
        !/===|!==|[^=!<>]==|!=|\.(includes|startsWith|endsWith|indexOf|search|match|has|get|set|delete)\(|\bcase\b|\[/.test(
          line,
        )
      )
        continue;
      for (const lit of literalsOnLine(line)) {
        const value = lit.value;
        if (CSS_DENYLIST.has(value)) continue;
        const before = line.slice(Math.max(0, lit.start - 80), lit.start);
        const after = line.slice(lit.end, lit.end + 80);
        const c = classify(before, after, value);
        if (!c) continue;

        let info = null;
        let match = null;
        if (exact.has(value)) {
          info = exact.get(value);
          match = "exact";
        } else if (
          SUBSTR_METHODS.has(c.position) &&
          /\s/.test(value.trim()) &&
          value.length >= 15
        ) {
          const hit = phrases.find((d) => d.value !== value && d.value.includes(value));
          if (hit) {
            info = hit.info;
            match = "substring-of";
          }
        }
        if (!info) continue;

        const expr = normalizeExpr(c.expr);
        const key = `${rel} | ${expr}`;
        const tier = match === "substring-of" || isPhrase(value) ? "REAL" : "WORD";
        violations.push({ rel, line: ln + 1, expr, key, value, match, tier, ...info });
      }
    }
  }

  const active = violations.filter((v) => !allow.has(v.key));
  return {
    violations,
    active,
    allowlisted: violations.filter((v) => allow.has(v.key)),
  };
}

// ---- CLI / build integration ----------------------------------------------
export function report({ active, allowlisted }) {
  const real = active.filter((v) => v.tier === "REAL");
  const word = active.filter((v) => v.tier === "WORD");
  const lines = [];
  lines.push(
    `compare-guard: ${active.length} unresolved (${real.length} REAL phrase/substring, ${word.length} single-word), ${allowlisted.length} allowlisted`,
  );
  lines.push("");
  const emit = (title, list) => {
    lines.push(`########## ${title} ##########`);
    for (const v of list) {
      lines.push(`  ${v.rel}:${v.line}  [${v.position ?? v.match}]`);
      lines.push(`     ${v.expr}`);
      lines.push(
        `     en/ru: ${JSON.stringify(v.en)} -> ${JSON.stringify(v.ru)}   (dict: ${v.scope})`,
      );
      lines.push(`     allowlist line:  ${v.rel} | ${v.expr}`);
      lines.push("");
    }
  };
  if (real.length)
    emit(
      "LIKELY-REAL phrase/substring — FIX to a stable key; allowlist ONLY if the compared value is external (git/OS stderr, DOM), never if it is our own string",
      real,
    );
  if (word.length)
    emit("SINGLE-WORD — allowlist if it is a stable enum/tag/DOM value, else fix", word);
  return lines.join("\n");
}

const isMain =
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url));
if (isMain) {
  const result = runCompareGuard();
  process.stdout.write(report(result) + "\n");
  if (result.active.length > 0) {
    process.stderr.write(
      `\ncompare-guard FAILED: ${result.active.length} unresolved comparison(s) against translated strings.\n`,
    );
    process.exit(1);
  }
  process.stdout.write("compare-guard OK\n");
}
