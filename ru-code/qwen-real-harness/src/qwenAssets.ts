// ru-code (S99): WHERE THE REAL-QWEN SUITES' qwen BUNDLES LIVE — the one absolute path.
//
// The qwen-code checkout is read-only, so every bundle is built in a COPY (README "Building the
// bundles") and kept in this directory, beside the checkouts. Nothing here gates a run: the gates
// stay the env switches (`RU_CODE_QWEN_CLI_JS`, `RU_CODE_MCP_PROBE=1`, …), and the run script
// (`scripts/real-qwen-run.sh`) fills them from these values — so `vp run -r test` never sees a
// path and never starts qwen.
export const QWEN_CODE_ASSETS =
  "/mnt/mac/Users/user/WORKSPACE/Projects/experements/t3-ru-code/qwen-code-assets";

/** qwen 0.21.1 as published: `npm ci` + bundle of the checkout @ 41b4ee8373, unpatched. */
export const QWEN_CLI_JS = `${QWEN_CODE_ASSETS}/qwen-build/dist/cli.js`;

/** The same tree + `qwen-patches/logonly.diff` (one debug line per session, no logic). */
export const QWEN_LOGPATCH_CLI_JS = `${QWEN_CODE_ASSETS}/qwen-build-logpatch/dist/cli.js`;
