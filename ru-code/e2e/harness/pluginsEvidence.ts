// ru-code: E2E HARNESS — named screenshots for the PLUGINS suite, plus the evidence hook.
//
// Every spec in `tests-plugins/` saves at least one screenshot under a STABLE, numbered name, so a
// run produces the same picture set every time and two runs can be diffed by eye. Two destinations,
// one call:
//
//   1. the suite's own artifacts dir (`.artifacts-plugins/screenshots/`) — always;
//   2. `RU_CODE_E2E_EVIDENCE_DIR` — the stage's evidence folder. UNSET means the default,
//      `WORKFLOW/evidence/e2e` (gitignored, which is where this project keeps its evidence); set it
//      to point a run somewhere else, or to `""` to turn the mirror off entirely.
//
// WHY NOT `harness/artifacts.ts`. That module is the RELEASE-artifact helper — server bundles,
// payload assembly, checksum manifests, install layouts. It has no screenshot concept to hang an
// env hook on, and every other suite would inherit the hook without wanting it. This is a new
// `harness/plugins*.ts` helper instead, which is the file slot this suite owns.
//
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Page } from "@playwright/test";

import { PLUGINS_ARTIFACTS_DIR } from "./pluginsBoot.ts";

/** Where every screenshot lands first. Disposable; regenerated on every run. */
export const PLUGINS_SCREENSHOT_DIR = NodePath.join(PLUGINS_ARTIFACTS_DIR, "screenshots");

/** The env hook. Explicitly empty ⇒ no second copy is made; unset ⇒ {@link DEFAULT_EVIDENCE_DIR}. */
export const PLUGINS_EVIDENCE_ENV_VAR = "RU_CODE_E2E_EVIDENCE_DIR";

/** `WORKFLOW/evidence/e2e` — where this project's staged evidence lives (gitignored). */
export const DEFAULT_EVIDENCE_DIR = NodePath.resolve(
  import.meta.dirname,
  "../../../WORKFLOW/evidence/e2e",
);

const evidenceDir = (): string | null => {
  const value = process.env[PLUGINS_EVIDENCE_ENV_VAR];
  if (value === undefined) return DEFAULT_EVIDENCE_DIR;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/**
 * Screenshot `page` as `<name>.png` (name without the extension), then mirror it into the evidence
 * dir when the hook is set. Returns the primary path so a spec can attach or assert on it.
 *
 * `fullPage` is off by default: these are UI states (a panel, a menu, a toast), and a full-page
 * capture of a chat app is mostly empty timeline.
 */
export async function saveEvidenceScreenshot(
  page: Page,
  name: string,
  options: {
    readonly fullPage?: boolean;
    /** Capture a region instead of the viewport — for a detail (a footer icon, a tooltip) that a
     *  1440×900 shot of a whole chat app would render too small to read. */
    readonly clip?: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
  } = {},
): Promise<string> {
  NodeFS.mkdirSync(PLUGINS_SCREENSHOT_DIR, { recursive: true });
  const file = NodePath.join(PLUGINS_SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({
    path: file,
    fullPage: options.fullPage ?? false,
    ...(options.clip === undefined ? {} : { clip: options.clip }),
  });
  const evidence = evidenceDir();
  if (evidence !== null) {
    NodeFS.mkdirSync(evidence, { recursive: true });
    NodeFS.copyFileSync(file, NodePath.join(evidence, `${name}.png`));
  }
  return file;
}

/**
 * Same two destinations for a JSON fact sheet — the machine-readable half of a screenshot (what the
 * assertions actually read), so evidence is not "a picture and trust me".
 */
export function saveEvidenceJson(name: string, body: unknown): string {
  NodeFS.mkdirSync(PLUGINS_SCREENSHOT_DIR, { recursive: true });
  const file = NodePath.join(PLUGINS_SCREENSHOT_DIR, `${name}.json`);
  NodeFS.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  const evidence = evidenceDir();
  if (evidence !== null) {
    NodeFS.mkdirSync(evidence, { recursive: true });
    NodeFS.copyFileSync(file, NodePath.join(evidence, `${name}.json`));
  }
  return file;
}
