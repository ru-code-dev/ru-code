// ru-code: e2e harness — the fake Pixso MCP plugin, RE-EXPORTED FROM THE PACKAGE.
//
// The server itself (both routes, the synthetic PNG, the realistic card tables and the
// capture loader) moved into `@smart-tools/pixso-core` on 2026-08-24 (the extraction wave)
// — before that it briefly lived in `@smart-tools/t3-code-pixso-mcp-assistant` (2026-08-21,
// decisions 510/511, when it first moved out of this repo). It is Pixso tooling, it needs
// the capture corpus, and both now live with pixso-core. This file stays only so the specs'
// imports keep their names — the import path below is already correct (DW-4 task 8).
//
// THE PATH GOES THROUGH THE `ru-code-packages` SYMLINK at this repo's root — the same
// gitignored switch `.pnpmfile.cjs` uses. Two reasons it is a symlink and not the installed
// package: the fake is deliberately NOT published (`files` ships `dist` + `src/styles.css`
// and nothing else), and Node refuses to strip TypeScript types for any file whose real path
// is inside `node_modules` — a symlink's real path is not.
//
// NO SYMLINK ⇒ THIS IMPORT THROWS, and the pixso specs fail loudly by design (owner ruling,
// 2026-08-21). They are dev-machine tests: without the linked packages checkout there is no
// corpus, and a silent skip would let a run report success having exercised nothing.
import * as NodePath from "node:path";

export * from "../../../ru-code-packages/packages/pixso-core/dev/fake-mcp/fakePixsoMcp.ts";

/**
 * The file to SPAWN when the harness needs the fake as its own process.
 *
 * Re-exporting the module is not enough for that: the server's run-when-invoked-directly
 * block compares `import.meta.url` against `process.argv[1]`, which never matches a
 * re-export, so spawning this file would exit 0 without binding 3667. `bootApp.ts` spawns
 * the real file — named here so the symlink path is written down ONCE.
 */
export const FAKE_PIXSO_ENTRY_PATH = NodePath.join(
  import.meta.dirname,
  "../../../ru-code-packages/packages/pixso-core/dev/fake-mcp/fakePixsoMcp.ts",
);
