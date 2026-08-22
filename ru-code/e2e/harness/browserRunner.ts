// ru-code: E2E HARNESS — the browser-suite launcher.
//
// A feature whose acceptance spec needs a real browser owns a Playwright CONFIG (its own testDir,
// timeout and retry policy) but should not own the plumbing that starts Playwright. This is that
// plumbing: run the given config through the `@ru-code/e2e` package, which is where the
// `@playwright/test` dependency and the installed browser live.
//
// Deliberately NOT the dev-harness config: these suites boot their own real installed app inside
// the spec, so they have no globalSetup and no shared harness state to inherit.
//
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

/** Run one Playwright config and return its exit status (never throws). */
export function runPlaywrightConfig(configPath: string): number {
  const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
  const result = NodeChildProcess.spawnSync(
    "pnpm",
    ["--filter", "@ru-code/e2e", "exec", "playwright", "test", "--config", configPath],
    { cwd: repoRoot, stdio: "inherit" },
  );
  return result.status ?? 1;
}
