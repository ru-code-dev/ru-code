// ru-code: keep the dev-linked @smart-tools packages FRESH before every build.
//
// THE DEFECT THIS REMOVES. `.pnpmfile.cjs` rewrites those deps to `file:` (it must — `link:`
// is a bare symlink, so each linked package resolves its own `effect` and a process that
// loads both gets TWO instances, which effect 4.0.0-beta.103 does not tolerate). But `file:`
// makes pnpm PACK the dependency and unpack a COPY into the virtual store: rebuilding the
// packages repo does NOT reach this app, and neither `pnpm install` nor `pnpm install
// --force` refresh it — both answer «Already up to date» in ~200 ms. The only thing that
// works is deleting pnpm's workspace-state file first. Measured 2026-08-20, decisions 510.
//
// Left to a human that is a silent failure: the app keeps building against the copy that
// existed at install time, with no error anywhere. So the build does it, not the human.
//
// NO SYMLINK ⇒ NO-OP. `ru-code-packages` is the gitignored dev-link switch; a clean clone
// installs @smart-tools from the registry and this script exits immediately. It never runs
// in CI, never touches a published install.
//
// ONLY WHEN THE DISTS ACTUALLY CHANGED. The published surface of every linked package
// (`dist/**` + its `package.json`) is content-hashed and compared against the fingerprint
// from the last refresh. Identical ⇒ exit; different ⇒ reinstall. Content, not mtime: a
// rebuild that emits identical bytes — the common case while iterating on tests — must not
// cost a reinstall. The fingerprint lives INSIDE `node_modules`, so it is discarded exactly
// when the install it describes is.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const APP_ROOT = NodePath.resolve(import.meta.dirname, "..");
const LINK_ROOT = NodePath.join(APP_ROOT, "ru-code-packages", "packages");
const STATE_FILE = NodePath.join(APP_ROOT, "node_modules", ".pnpm-workspace-state-v1.json");
const FINGERPRINT_FILE = NodePath.join(APP_ROOT, "node_modules", ".dev-link-fingerprint.json");

if (!NodeFS.existsSync(LINK_ROOT)) process.exit(0);

/** Every published file of one package: `dist/**` plus the manifest that declares it. */
function publishedFiles(packageDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  const dist = NodePath.join(packageDir, "dist");
  if (NodeFS.existsSync(dist)) walk(dist);
  const manifest = NodePath.join(packageDir, "package.json");
  if (NodeFS.existsSync(manifest)) out.push(manifest);
  return out;
}

function fingerprint() {
  const hash = NodeCrypto.createHash("sha256");
  for (const name of NodeFS.readdirSync(LINK_ROOT).sort()) {
    const packageDir = NodePath.join(LINK_ROOT, name);
    if (!NodeFS.statSync(packageDir).isDirectory()) continue;
    for (const file of publishedFiles(packageDir)) {
      hash.update(NodePath.relative(LINK_ROOT, file));
      hash.update("\0");
      hash.update(NodeFS.readFileSync(file));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

const current = fingerprint();
const previous = NodeFS.existsSync(FINGERPRINT_FILE)
  ? (JSON.parse(NodeFS.readFileSync(FINGERPRINT_FILE, "utf8")).sha256 ?? null)
  : null;

if (previous === current) {
  process.stdout.write("[dev-link] linked packages unchanged — no reinstall\n");
  process.exit(0);
}

process.stdout.write(
  `[dev-link] linked packages changed (${previous === null ? "no fingerprint yet" : "dist differs"}) — reinstalling\n`,
);
NodeFS.rmSync(STATE_FILE, { force: true });
NodeChildProcess.execFileSync("pnpm", ["install"], { cwd: APP_ROOT, stdio: "inherit" });

// AFTER the install, not before: a fingerprint written on a failed install would claim the
// tree is fresh when it is not, which is the very lie this script exists to prevent.
NodeFS.mkdirSync(NodePath.dirname(FINGERPRINT_FILE), { recursive: true });
NodeFS.writeFileSync(FINGERPRINT_FILE, `${JSON.stringify({ sha256: fingerprint() }, null, 2)}\n`);
process.stdout.write("[dev-link] refreshed\n");
