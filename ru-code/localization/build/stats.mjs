// localize:stats — a quick coverage snapshot of the dictionary.

import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { loadDictionary } from "./locate.mjs";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../..", import.meta.url)));
void REPO_ROOT;

const entries = loadDictionary();
const area = (scope) => {
  if (scope.startsWith("apps/web/")) return "apps/web";
  if (scope.startsWith("apps/server/")) return "apps/server";
  if (scope.startsWith("apps/")) return scope.split("/").slice(0, 2).join("/");
  if (scope.startsWith("packages/")) return "packages/" + scope.split("/")[1];
  return "other";
};

const byArea = {};
const byKind = { str: 0, jsx: 0, tpl: 0 };
const filesByArea = {};
let nth = 0;
for (const e of entries) {
  const a = area(e.scope);
  byArea[a] = (byArea[a] ?? 0) + 1;
  (filesByArea[a] ??= new Set()).add(e.scope);
  byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  if (e.nth != null) nth++;
}

const files = new Set(entries.map((e) => e.scope)).size;
console.log(`Dictionary: ${entries.length} entries across ${files} files`);
console.log(`  by kind:  str ${byKind.str} · jsx ${byKind.jsx} · tpl ${byKind.tpl}`);
console.log(`  nth-pinned (duplicates/subsets): ${nth}`);
console.log(`  by area:`);
for (const [a, n] of Object.entries(byArea).sort((x, y) => y[1] - x[1])) {
  console.log(
    `    ${a.padEnd(24)} ${String(n).padStart(5)} entries  ·  ${filesByArea[a].size} files`,
  );
}
console.log(
  `\nRun \`pnpm localize:new\` for the untranslated backlog, \`pnpm localize:check\` for drift.`,
);
