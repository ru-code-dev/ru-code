// Whether the localization build gate hard-fails on an unapplied translation.
//
// The switch is the FAIL_ON_LOCALIZATION_ERROR constant in @ru-code/branding
// (ru-code/branding/src/index.ts). We read it straight from source with `fs` rather than
// importing the package, because this file runs as plain Node (both inside the bundler plugin
// and as the standalone verifyBuild script) where a TypeScript import wouldn't resolve — and
// because branding is a LATER patch in the fork series than the localization engine.
//
// That ordering is deliberate: on an upstream re-sync the fork's commits are replayed onto
// fresh t3, and at intermediate commits the accumulated dictionary intentionally overshoots
// the still-partial source. Until the branding patch is applied this file does not exist, so
// we treat "absent / not literally `true`" as LENIENT — mid-replay builds localize what they
// can and never false-fail. Once branding lands with `= true`, the finished fork is strict and
// the build fails if even one shipped translation didn't apply.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../..", import.meta.url)));
const BRANDING_SOURCE = NodePath.join(REPO_ROOT, "ru-code/branding/src/index.ts");

export function failOnLocalizationError() {
  try {
    const source = NodeFS.readFileSync(BRANDING_SOURCE, "utf8");
    return /FAIL_ON_LOCALIZATION_ERROR\s*=\s*true\b/.test(source);
  } catch {
    return false; // branding not applied yet (mid-resync) — localize leniently.
  }
}
