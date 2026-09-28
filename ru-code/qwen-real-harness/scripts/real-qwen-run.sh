#!/usr/bin/env bash
# ru-code (S99): THE real-qwen suite runner — `pnpm test:e2e:real-qwen [<case regex>]`.
#
# Runs apps/server `test:real-qwen` (vitest over src/ru-code/tests/qwen/real-acp) with the gates
# ON, filled from the one bundle constant (src/qwenAssets.ts), under the e2e mutex:
#   - mkdir lock `<repo>/WORKFLOW/logs/.e2e-lock` (one e2e suite at a time on this machine);
#   - the concurrent-run check before and after (another worktree's Playwright / app server);
#   - the stray check after (a rig process left behind).
# Every run appends command · exit · duration · HEAD · checks to `$REAL_QWEN_OUT/runs.log`.
#
#   $1               optional vitest `-t` pattern (a case name, e.g. "P-01-baseline"); none = all
#   REAL_QWEN_OUT    evidence root (default <repo>/WORKFLOW/logs/real-qwen); each case → <out>/<case>
#
# The app under test is the BUILT server (apps/server/dist) — `pnpm build` first.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(git -C "$HERE" rev-parse --show-toplevel)
OUT=${REAL_QWEN_OUT:-$ROOT/WORKFLOW/logs/real-qwen}
LOCK=$ROOT/WORKFLOW/logs/.e2e-lock
CASE=${1:-}
RUNLOG=$OUT/runs.log

constant() {
  node --input-type=module -e "const m = await import('$HERE/../src/qwenAssets.ts'); process.stdout.write(m.$1);"
}
QWEN_CLI_JS=$(constant QWEN_CLI_JS)
QWEN_LOGPATCH_CLI_JS=$(constant QWEN_LOGPATCH_CLI_JS)
for bundle in "$QWEN_CLI_JS" "$QWEN_LOGPATCH_CLI_JS"; do
  if [ ! -f "$bundle" ]; then
    echo "no qwen bundle at $bundle — build it (ru-code/qwen-real-harness/README.md)" >&2
    exit 2
  fi
done

mkdir -p "$OUT" "$(dirname "$LOCK")"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "LOCK HELD: $LOCK" >&2
  exit 90
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

OTHER=$(pgrep -af "playwrigh[t]|dist/bin.mj[s]" | grep -v "$ROOT" || true)
{
  echo "=== $(date -Is) case=/${CASE}/ HEAD=$(git -C "$ROOT" rev-parse HEAD) qwen=$QWEN_CLI_JS"
  echo "concurrent-before: ${OTHER:-none}"
  echo "cmd: RU_CODE_QWEN_CLI_JS=$QWEN_CLI_JS RU_CODE_MCP_PROBE_LOGPATCH_CLI_JS=$QWEN_LOGPATCH_CLI_JS RU_CODE_MCP_PROBE=1 RU_CODE_MCP_PROBE_PLAYWRIGHT=1 RU_CODE_MCP_PROBE_OUT=$OUT pnpm --filter t3 test:real-qwen${CASE:+ -t \"$CASE\"}"
} >> "$RUNLOG"

START=$(date +%s)
cd "$ROOT"
RU_CODE_QWEN_CLI_JS=$QWEN_CLI_JS \
  RU_CODE_MCP_PROBE_LOGPATCH_CLI_JS=$QWEN_LOGPATCH_CLI_JS \
  RU_CODE_MCP_PROBE=1 \
  RU_CODE_MCP_PROBE_PLAYWRIGHT=1 \
  RU_CODE_MCP_PROBE_OUT=$OUT \
  pnpm --filter t3 test:real-qwen ${CASE:+-t "$CASE"} > "$OUT/last-vitest.log" 2>&1
CODE=$?

OTHER_AFTER=$(pgrep -af "playwrigh[t]|dist/bin.mj[s]" | grep -v "$ROOT" || true)
# node processes only: a shell whose command line merely MENTIONS these paths is not a stray.
STRAY=$(pgrep -af "^[^ ]*node .*(mcp-probe-sandbo[x]|cliProx[y]|fakeMcpStdi[o]|fakeMcpHtt[p]|qwen-code-assets/qwen-buil[d])" || true)
{
  echo "exit: $CODE  duration: $(($(date +%s) - START))s  end: $(date -Is)"
  echo "concurrent-after: ${OTHER_AFTER:-none}"
  echo "stray-after: ${STRAY:-none}"
  grep -aE "✓|✗|×|Test Files|Tests |FAIL|passed|failed|skipped" "$OUT/last-vitest.log" | tail -8
} >> "$RUNLOG"
tail -12 "$RUNLOG"
exit $CODE
