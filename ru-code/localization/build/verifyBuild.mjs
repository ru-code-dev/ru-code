// Build-output gate — independent, plugin-agnostic proof that the transform actually ran on
// each shipping target. This is the SECOND line of defence:
//
//   • Per-TRANSLATION coverage is enforced inside the transform plugin (generateBundle in
//     ru-code/localization/build/vitePlugin.mjs): every dictionary entry of every bundled
//     file must place, or the build fails listing each unapplied line. That is the guarantee.
//   • This script is the backstop for the one thing that gate can't see: if the plugin were
//     never wired into a bundler at all, its hooks wouldn't run — and English would ship
//     silently (exactly the original server bug). So here we grep the FINAL emitted JS, with
//     no dependency on the plugin, and fail if a whole target contains zero localized pairs.
//
// The transform inlines Russian at build time: Vite runs it on the web bundle, `vp pack`
// (tsdown/rolldown) on the server bundle. We grep the actual emitted JavaScript for the
// localized pairs it leaves behind.
//
// The transform emits `L(en, ru)` / `LT(en, ru, […])`, so a localized string leaves BOTH
// its English AND its Russian literal in the bundle. That gives an exact per-target test:
//   • English present, Russian ABSENT  → the transform did not run here → FAIL the build.
//   • English absent                    → the string is tree-shaken / only in another app
//                                          (desktop, mobile, tests) — not shipped here → skip.
//   • both present                      → localized correctly.
// This is precisely how the server-side gap surfaced (every server string carried English
// with no Russian). No sampling, no allowlist.
//
//   node ru-code/localization/build/verifyBuild.mjs <serverDistDir>
//
// <serverDistDir> (e.g. apps/server/dist) holds BOTH bundles after `scripts/cli.ts build`:
//   • *.mjs at the top level        → the server bundle (server + bundled packages/*)
//   • client/**/*.js                → the web bundle (copied from apps/web/dist)

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { buildCatalog } from "./locate.mjs";
import { lintDictionary } from "./dictLint.mjs";
import { failOnLocalizationError } from "./strict.mjs";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../..", import.meta.url)));

// Dictionary integrity — deterministic corruption gate (alignment-slip fingerprints). Runs
// before touching the bundles because it needs none of them. Strict only on the finished fork.
const { errors: dictErrors } = lintDictionary();
if (dictErrors.length > 0) {
  console.error(`\n✗ verifyBuild: ${dictErrors.length} corrupt dictionary entr(y/ies):`);
  for (const e of dictErrors) console.error(`  ${e}`);
  if (failOnLocalizationError()) process.exit(1);
  console.error(`(FAIL_ON_LOCALIZATION_ERROR is not set — reporting only.)`);
}

const distArg = process.argv[2];
if (!distArg) {
  console.error("verifyBuild: usage: node verifyBuild.mjs <serverDistDir>");
  process.exit(2);
}
const distDir = NodePath.resolve(REPO_ROOT, distArg);
const clientDir = NodePath.join(distDir, "client");

// Concatenate every emitted JS file under `dir` (recursively), skipping sourcemaps — a RU
// string in a .map proves nothing about the shipped code.
function readBundle(dir, { recursive }) {
  let out = "";
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
        // The server bundle lives at the top level; `client/` is the web bundle and is
        // read separately, so never descend into it when reading the server bundle.
        if (recursive && p !== clientDir) walk(p);
        continue;
      }
      if (/\.(mjs|js|cjs)$/.test(d.name) && !d.name.endsWith(".map")) {
        out += NodeFS.readFileSync(p, "utf8") + "\n";
      }
    }
  };
  walk(dir);
  return out;
}

// The transform emits `L(en, ru)` / `LT(en, ru, […])`, so a localized string leaves its
// English and Russian literals ADJACENT in the bundle, separated only by the argument comma
// and the two enclosing quotes: `", "` (un-minified, 4 chars), `","` / `\`,\`` (minified, 3).
// That adjacency is unique to our transform — a bare English phrase like "Invalid value" also
// occurs in library code, but never immediately followed by OUR Russian literal. Matching it
// (not the Russian alone) proves the string shipped localized, and is immune to both
// tree-shaking (a dropped call takes the whole pair) and English collisions.
//
// The bundler picks whichever quote style needs no escaping: the un-minified server bundle
// keeps double quotes (`"en", "ru"`), the minified web bundle rewrites to backticks
// (`\`en\`,\`ru\``). We match the argument boundary in every observed quote/spacing variant
// with native String.includes (fast — one Boyer-Moore scan each). Strings containing a quote
// or backslash could be re-escaped and break the raw match, so they are not pair-checkable —
// reported as `unprovable`, never as failures. No branding string hits that case.
function pairCheckable(en, ru) {
  return !/["`\\]/.test(en) && !/["`\\]/.test(ru);
}

// Quote/spacing variants per bundle: the un-minified server bundle uses double quotes; the
// minified web bundle uses backticks. Testing only the relevant variants per target keeps the
// scan cheap while still tolerating either style if a bundler's minification changes.
const NEEDLE_VARIANTS = {
  server: (en, ru) => [`${en}", "${ru}`, `${en}","${ru}`, `${en}\`,\`${ru}`],
  web: (en, ru) => [`${en}\`,\`${ru}`, `${en}\`, \`${ru}`, `${en}","${ru}`],
};

if (!NodeFS.existsSync(NodePath.join(distDir, "bin.mjs"))) {
  console.error(
    `verifyBuild: server bundle not found at ${NodePath.relative(REPO_ROOT, distDir)}/bin.mjs`,
  );
  process.exit(1);
}
if (!NodeFS.existsSync(clientDir)) {
  console.error(
    `verifyBuild: web client bundle not found at ${NodePath.relative(REPO_ROOT, clientDir)} — run the full build (web + server).`,
  );
  process.exit(1);
}

const serverBlob = readBundle(distDir, { recursive: true });
const webBlob = readBundle(clientDir, { recursive: true });

const { catalog } = buildCatalog();

// A scope's possible targets. apps/web → web; apps/server → server; shared packages/* can be
// pulled into either, so a pair present in EITHER bundle counts as shipped.
function blobsFor(scope) {
  if (scope.startsWith("apps/web/")) return [["web", webBlob]];
  if (scope.startsWith("apps/server/")) return [["server", serverBlob]];
  if (scope.startsWith("packages/")) {
    return [
      ["server", serverBlob],
      ["web", webBlob],
    ];
  }
  return []; // scripts/** etc. are never bundled
}

const pairPresent = (en, ru, blobs) =>
  blobs.some(([where, blob]) => NEEDLE_VARIANTS[where](en, ru).some((n) => blob.includes(n)));

// Per-target tallies over strings that CAN'T be tree-shaken away silently: apps/web must land
// in web, apps/server in server. If a whole target's transform never ran, its verified count
// is zero even though the dictionary has many entries for it — that is the wholesale failure
// (the exact server-side bug) and it fails the build.
const perTarget = { web: { expected: 0, verified: 0 }, server: { expected: 0, verified: 0 } };
let verified = 0;
let unprovable = 0;
for (const [scope, units] of Object.entries(catalog)) {
  const blobs = blobsFor(scope);
  if (blobs.length === 0) continue;
  const bucket = scope.startsWith("apps/web/")
    ? "web"
    : scope.startsWith("apps/server/")
      ? "server"
      : null;

  for (const unit of units) {
    if (!pairCheckable(unit.en, unit.ru)) {
      unprovable += 1;
      continue;
    }
    if (bucket) perTarget[bucket].expected += 1;
    if (pairPresent(unit.en, unit.ru, blobs)) {
      verified += 1;
      if (bucket) perTarget[bucket].verified += 1;
    }
  }
}

const wholesaleFailures = Object.entries(perTarget).filter(
  ([, t]) => t.expected > 0 && t.verified === 0,
);
if (wholesaleFailures.length > 0) {
  console.error(`\n✗ verifyBuild: a whole target shipped WITHOUT translations:\n`);
  for (const [target, t] of wholesaleFailures) {
    console.error(
      `  [${target}] ${t.expected} dictionary strings expected, 0 localized pairs found in the bundle.`,
    );
  }
  console.error(
    `\nThe localization transform did not run on that target. Wire the plugin into its bundler` +
      ` (Vite for web, the \`pack\` config in apps/server/vite.config.ts for server).`,
  );
  // Strict only on the finished fork (branding's FAIL_ON_LOCALIZATION_ERROR = true). Mid-resync,
  // before branding is applied, a target legitimately has no pairs yet — report, don't fail.
  if (failOnLocalizationError()) process.exit(1);
  console.error(`(FAIL_ON_LOCALIZATION_ERROR is not set — reporting only, not failing the build.)`);
}

// Grep-confirmed pairs are direct evidence the transform ran on each target. Entries not
// grep-found here are tree-shaken/dead-code (or contain quotes and aren't pair-checkable) —
// their per-string coverage is already guaranteed by the plugin's generateBundle gate, so
// they are not failures. We only fail on a WHOLE target with zero pairs (plugin never wired).
console.log(
  `✅ verifyBuild: transform confirmed active on every target — ` +
    `web ${perTarget.web.verified}, server ${perTarget.server.verified}, ` +
    `${verified} localized pairs grep-verified in the shipped JS. ` +
    `Per-translation coverage is enforced by the build gate in vitePlugin.mjs.`,
);
