// ru-code: auto-update FEATURE — entry point for the real-browser acceptance cycle.
// Wired as a step in the root `test:e2e:all` chain (invoked directly via `node
// ru-code/e2e/features/auto-update/browserRun.ts`). The launcher itself is generic
// (harness/browserRunner.ts); all this file decides is WHICH config to run.
//
// @effect-diagnostics nodeBuiltinImport:off

import * as NodePath from "node:path";

import { runPlaywrightConfig } from "../../harness/browserRunner.ts";

process.exit(runPlaywrightConfig(NodePath.join(import.meta.dirname, "playwright.config.ts")));
