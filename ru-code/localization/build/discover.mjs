// localize:new — find untranslated USER-FACING strings and write MISSING.md.
//
//   pnpm localize:new                 → whole repo (the full backlog)
//   pnpm localize:new --range A B     → only files changed between commits A and B
//   pnpm localize:new --range A..B    → same
//   pnpm localize:new --path <p>      → a single file OR a folder (any package), recursive
//
// Technique: collect display units (nodes.mjs already excludes keys/types/imports/case/
// comparison/seams), drop anything already in the dictionary, then apply a user-facing
// heuristic (drops CSS class lists, identifiers, urls, hex, CONST_CASE) and rank the rest.
// apps/mobile, tests, and non-display are excluded. Heuristic ⇒ a triage list, not gospel:
// false negatives are fine (add by hand); it errs toward dropping ambiguous noise.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { collectDisplayUnits } from "./nodes.mjs";
import { loadDictionaryByScope, sourceFiles, EXCLUDE_PREFIXES } from "./locate.mjs";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../..", import.meta.url)));
const OUT = NodePath.join(REPO_ROOT, "ru-code/localization/MISSING.md");
const git = (a) =>
  NodeChildProcess.execSync(`git ${a}`, { cwd: REPO_ROOT, maxBuffer: 1 << 30, encoding: "utf8" });
const includeLow = process.argv.includes("--all");

// Generated code, codegen output, and dev/tooling scripts hold schema/enum/CLI literals,
// not shipped UI — never translation candidates.
const isNoiseFile = (rel) => /\/_generated\/|\.gen\.[cm]?tsx?$|(^|\/)scripts\//.test(rel);

// Rank a display string as user-facing, or return null to drop it.
function classify(text) {
  const t = text.trim();
  if (t.length < 2 || !/[A-Za-zА-Яа-яЁё]/.test(t)) return null;
  if (/^https?:\/\//.test(t) || /^\/[\w./-]+$/.test(t)) return null; // url / path
  if (/^#?[0-9a-fA-F]{3,8}$/.test(t)) return null; // hex color
  if (/^[A-Z0-9_]+$/.test(t)) return null; // CONST_CASE
  if (/^[a-z][a-zA-Z0-9]*$/.test(t)) return null; // camelCase identifier
  const tokens = t.split(/\s+/);
  const cssish = tokens.every((tok) => /^[a-z0-9]+([-:/.][a-z0-9.]+)*$/.test(tok));
  if (cssish) return null; // tailwind class list / kebab ids / lowercase enums
  const cap = /^[A-ZА-ЯЁ]/.test(t);
  if (cap && (tokens.length > 1 || /[.!?…:]$/.test(t))) return "high"; // sentence/phrase
  if (cap) return "medium"; // capitalized single-word label
  return "low";
}

function lineAt(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

// Recursively collect .ts/.tsx (non-test) under a directory — for `--path <folder>`.
function walkTsFiles(absDir) {
  const skip = new Set([
    "node_modules",
    "dist",
    "dist-electron",
    ".vite-plus",
    ".vite",
    "build",
    ".git",
    "_generated",
  ]);
  const out = [];
  const walk = (dir) => {
    let dirents;
    try {
      dirents = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const p = NodePath.join(dir, d.name);
      if (d.isDirectory()) {
        if (!skip.has(d.name)) walk(p);
      } else if (/\.(ts|tsx)$/.test(d.name) && !/\.test\.[tj]sx?$/.test(d.name)) {
        out.push(p);
      }
    }
  };
  walk(absDir);
  return out;
}

// Files to scan.
const args = process.argv.slice(2);
const rangeIdx = args.indexOf("--range");
const pathIdx = args.indexOf("--path");
let files;
let label;
if (pathIdx !== -1) {
  const target = args[pathIdx + 1];
  if (!target || target.startsWith("--")) {
    console.error("localize:new --path <file-or-folder>: missing path argument");
    process.exit(2);
  }
  const abs = NodePath.resolve(REPO_ROOT, target);
  let stat;
  try {
    stat = NodeFS.statSync(abs);
  } catch {
    console.error(`localize:new --path: not found: ${target}`);
    process.exit(2);
  }
  label = `path ${NodePath.relative(REPO_ROOT, abs).split(NodePath.sep).join("/")}`;
  files = (stat.isDirectory() ? walkTsFiles(abs) : [abs])
    .map((a) => NodePath.relative(REPO_ROOT, a).split(NodePath.sep).join("/"))
    .filter(
      (f) =>
        /\.(ts|tsx)$/.test(f) &&
        !/\.test\.[tj]sx?$/.test(f) &&
        !EXCLUDE_PREFIXES.some((p) => f.startsWith(p)) &&
        !isNoiseFile(f),
    );
} else if (rangeIdx !== -1) {
  const rest = args.slice(rangeIdx + 1).filter((a) => !a.startsWith("--"));
  const [a, b] = rest.length === 1 && rest[0].includes("..") ? rest[0].split("..") : rest;
  label = `range ${a}..${b}`;
  files = git(`diff --name-only ${a} ${b}`)
    .trim()
    .split("\n")
    .filter(
      (f) =>
        /\.(ts|tsx)$/.test(f) &&
        !/\.test\.[tj]sx?$/.test(f) &&
        !EXCLUDE_PREFIXES.some((p) => f.startsWith(p)),
    )
    .filter((f) => !isNoiseFile(f) && NodeFS.existsSync(NodePath.join(REPO_ROOT, f)));
} else {
  label = "whole repo";
  files = sourceFiles()
    .map((abs) => NodePath.relative(REPO_ROOT, abs).split(NodePath.sep).join("/"))
    .filter((f) => !isNoiseFile(f));
}

const dictByScope = loadDictionaryByScope();
const results = []; // { file, line, kind, rank, en }
for (const file of files) {
  let source;
  try {
    source = NodeFS.readFileSync(NodePath.join(REPO_ROOT, file), "utf8");
  } catch {
    continue;
  }
  const covered = new Set((dictByScope.get(file) ?? []).map((e) => e.kind + "\0" + e.en));
  for (const u of collectDisplayUnits(source, file)) {
    if (covered.has(u.kind + "\0" + u.text)) continue; // already translated
    const rank = classify(u.text);
    if (!rank) continue;
    results.push({ file, line: lineAt(source, u.start), kind: u.kind, rank, en: u.text });
  }
}

const order = { high: 0, medium: 1, low: 2 };
results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const counts = { high: 0, medium: 0, low: 0 };
for (const r of results) counts[r.rank]++;

// Write MISSING.md grouped by file (high + medium by default; low needs --all).
const shown = results.filter((r) => includeLow || r.rank !== "low");
const byFile = new Map();
for (const r of shown) {
  if (!byFile.has(r.file)) byFile.set(r.file, []);
  byFile.get(r.file).push(r);
}
const md = [];
md.push(`# Missing user-facing translations`);
md.push(``);
md.push(
  `Scope: **${label}** · shown **${shown.length}** (high ${counts.high}, medium ${counts.medium})` +
    (includeLow ? `` : ` · ${counts.low} low-confidence hidden (\`--all\` to include)`),
);
md.push(``);
md.push(`Heuristic list — triage and add real UI strings to the matching \`dict/<file>.json\`.`);
md.push(`Ranks: **high** = sentence/phrase, **medium** = capitalized label, **low** = uncertain.`);
md.push(``);
for (const [file, rows] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
  md.push(`## ${file} (${rows.length})`);
  md.push(``);
  md.push(`| line | rank | kind | English |`);
  md.push(`|------|------|------|---------|`);
  for (const r of rows.sort((x, y) => order[x.rank] - order[y.rank] || x.line - y.line)) {
    md.push(
      `| ${r.line} | ${r.rank} | ${r.kind} | ${JSON.stringify(r.en).replace(/\|/g, "\\|")} |`,
    );
  }
  md.push(``);
}
NodeFS.writeFileSync(OUT, md.join("\n") + "\n");

console.log(`localize:new (${label}): scanned ${files.length} files`);
console.log(
  `untranslated user-facing candidates: ${results.length} (high ${counts.high}, medium ${counts.medium}, low ${counts.low})`,
);
console.log(`wrote ${NodePath.relative(REPO_ROOT, OUT)}`);
