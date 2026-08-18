// Revert the entire bilingual localization layer back to pristine upstream English.
//
// Because the bulk of localization is an in-memory build transform, the only files
// that actually differ from upstream are the workspace/dep wiring, the two vite
// configs, and the ~14 hand seams. This tool lists that footprint and, with --force,
// restores those tracked files to the EN base commit and removes the (untracked)
// localization package + generated catalog. Dry-run by default.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../..", import.meta.url)));
const BASE = "a762f74d5"; // EN strip commit — the localization branch base
const git = (args) =>
  NodeChildProcess.execSync(`git ${args}`, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });

const tracked = git(`diff --name-only ${BASE}`).trim().split("\n").filter(Boolean);
const pkgDir = "ru-code/localization";
const force = process.argv.includes("--force");

console.log(`Localization footprint vs ${BASE}:`);
console.log(`  tracked files changed: ${tracked.length}`);
for (const f of tracked) console.log(`    ${f}`);
console.log(`  untracked package: ${pkgDir}/`);

if (!force) {
  console.log(
    "\nDry run. Re-run with --force to restore tracked files to upstream and remove the package.",
  );
  process.exit(0);
}

if (tracked.length > 0) {
  git(`checkout ${BASE} -- ${tracked.map((f) => JSON.stringify(f)).join(" ")}`);
}
NodeFS.rmSync(NodePath.join(REPO_ROOT, pkgDir), { recursive: true, force: true });
console.log("\nReverted to upstream English. Run `pnpm install` to drop the workspace package.");
