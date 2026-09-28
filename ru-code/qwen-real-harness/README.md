# @ru-code/qwen-real-harness — the oracle for the fake ACP agent

Drives the **real qwen CLI** over a **real ACP connection** against a scripted local
OpenAI-compatible mock, and captures every `session/update` frame it sends.

Why it exists: every compression assertion in
`apps/server/src/ru-code/tests/qwen/fake-acp/` rests on the claim that
`qwen021Frames.ts` reproduces what qwen actually puts on the wire. That claim was a
careful reading of qwen's emitters — good, but a reading. This package checks it against
the binary.

**When a capture and the fake disagree, the FAKE is wrong.** The builders are a
transcription; the capture is qwen. Fix `qwen021Frames.ts` (and the DSL in
`fakeAcpCore.ts` when the channel itself moved), re-run, and only then look at the app.

## Running it

Nothing here runs without a built bundle, and nothing here runs from `vp run -r test`: every
real-qwen case is gated by env switches that only the run script turns on.

```bash
pnpm build                                   # the MCP probe drives the BUILT app server
pnpm test:e2e:real-qwen                      # the whole real-qwen suite
pnpm test:e2e:real-qwen "P-01-baseline"      # one case (a vitest -t pattern)
```

`test:e2e:real-qwen` → this package's `test:e2e` → `scripts/real-qwen-run.sh` → apps/server
`test:real-qwen` (`vp test run src/ru-code/tests/qwen/real-acp`). The script:

- reads the bundle paths from ONE constant, `src/qwenAssets.ts` (`QWEN_CODE_ASSETS`, and
  `QWEN_CLI_JS` / `QWEN_LOGPATCH_CLI_JS` under it), and fills the gates from it:
  `RU_CODE_QWEN_CLI_JS` (every real-acp case), `RU_CODE_MCP_PROBE=1` (the MCP probe),
  `RU_CODE_MCP_PROBE_LOGPATCH_CLI_JS` (its log-patched cases), `RU_CODE_MCP_PROBE_PLAYWRIGHT=1`
  (its real `@playwright/mcp` cases, network);
- takes the machine's e2e mutex `<repo>/WORKFLOW/logs/.e2e-lock` (exit 90 when held), checks for
  another worktree's e2e processes before and after, and for a rig process left behind;
- appends command · exit · duration · HEAD · those checks to `$REAL_QWEN_OUT/runs.log`
  (default `<repo>/WORKFLOW/logs/real-qwen`); each MCP probe case writes its evidence to
  `$REAL_QWEN_OUT/<case>/`.

The gates stay env switches on purpose: the root `pnpm test` (`vp run -r test`) runs
`apps/server`'s whole vitest tree, `real-acp` included, and there every case is **skipped**
because no switch is set. The constant is only ever read by the script.

## Building the bundles (never in place)

The qwen-code checkout is READ-ONLY. Bundles are built in a COPY and kept in
`QWEN_CODE_ASSETS` (`…/t3-ru-code/qwen-code-assets`, beside the checkouts):

```bash
QWEN_SRC=/mnt/mac/Users/user/WORKSPACE/Projects/experements/t3-ru-code/qwen-code   # v0.21.1
ASSETS=/mnt/mac/Users/user/WORKSPACE/Projects/experements/t3-ru-code/qwen-code-assets

copy() {   # $1 = target dir
  mkdir -p "$1"
  ( cd "$QWEN_SRC" && tar --exclude=.git --exclude=node_modules --exclude=dist \
      --exclude=bundle -cf - . ) | ( cd "$1" && tar -xf - )
}

copy "$ASSETS/qwen-build"
( cd "$ASSETS/qwen-build" && npm ci )          # its postinstall also runs the bundle

copy "$ASSETS/qwen-build-logpatch"
( cd "$ASSETS/qwen-build-logpatch" \
  && patch -p1 < <repo>/ru-code/qwen-real-harness/qwen-patches/logonly.diff \
  && npm ci )

node "$ASSETS/qwen-build/dist/cli.js" --version             # must print 0.21.1
sha256sum "$ASSETS"/qwen-build*/dist/cli.js                 # record them in the run's log
```

`npm ci` is what makes the bundle possible: the read-only checkout has only a partial
install (its root `node_modules` carries devDependencies, the workspace packages' own
deps are not linked), so `node esbuild.config.js` cannot resolve `jsonc-parser` or
`esbuild-plugin-wasm` there. The copy pays a full install once and then bundles as part
of the same postinstall.

`qwen-patches/logonly.diff` adds ONE `debugLogger.debug` line per session (the per-scope,
merged and effective settings, and qwen's settings warnings) — no logic. Only the MCP probe's
FORMAT and OWN-SERVER cases use that bundle.

The bundles in `qwen-code-assets` today are the S94 builds, copied: plain `dist/cli.js` sha256
`9949c266…`, log-patched `47834a0f…` (checkout `41b4ee8373`).

## What it captures

Per scenario, into `outDir` (a temp dir unless you pass one):

| file                     | contents                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `acp-updates.jsonl`      | every raw `session/update` **params**, one per line, in arrival order                                                                                                    |
| `prompt-responses.jsonl` | per turn: the prompt, its `sessionId`, its `stopReason` **or** its JSON-RPC error, and the frames that arrived while it was in flight                                    |
| `acp-requests.jsonl`     | every agent→host request (`session/request_permission`, `fs/*`). Empty is the expected result under `--yolo`, and is the positive confirmation of that rather than a gap |
| `model-requests.jsonl`   | every `/chat/completions` body the mock served — including the compression side-query                                                                                    |
| `stderr.log`             | the child's stderr                                                                                                                                                       |
| `run-meta.json`          | the run's own provenance: scenario, purpose, bundle path, session ids, per-turn outcome, counts, duration                                                                |

Nothing is filtered or normalised on the way out. A harness that pre-digests its
evidence cannot be used to correct the fake it exists to check.

## Scenarios

| name                        | what it forces the binary to do                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manual-compress`           | a `/compress` sent as prompt text — the two `agent_message_chunk`s stamped `_meta.source:"slash_command"`, then `end_turn`                                           |
| `manual-compress-then-turn` | a `/compress` and then an ordinary turn on the SAME session — no restart is needed for the next prompt to answer                                                     |
| `auto-compaction`           | qwen's OWN pre-send compaction, forced by an inflated `usage.prompt_tokens` on turn 1 — the BARE `agent_message_chunk` notice, then the answer, then the usage frame |
| `compress-failure`          | a `/compress` whose summariser call gets HTTP 500 — the prompt is REJECTED with a JSON-RPC error and NO frame is emitted                                             |
| `two-sessions`              | two ACP sessions on one agent process, compaction in the second — every frame carries its own `sessionId`                                                            |

`auto-compaction` is arithmetic, not luck: qwen measures its auto threshold against the
model's context window, which for an unknown slug is `DEFAULT_TOKEN_LIMIT = 200_000`
(`tokenLimits.ts:11`), giving
`auto = min(0.85·200 000, 200 000 − 20 000 − 13 000) = 167 000`
(`chatCompressionService.ts:159-254`). The estimate it compares against is seeded from
the previous response's `usage.prompt_tokens`, so a first turn reporting
`INFLATED_PROMPT_TOKENS = 190 000` puts the second turn over the line.

## Isolation

The spawn sees none of the machine's own state: `HOME` and `QWEN_HOME` are the run's own
directories, with a `settings.json` that disables telemetry and usage statistics, and
`OPENAI_BASE_URL` points at the mock. `context.autoCompactThreshold` is deliberately
absent from those settings — it is read once at session creation
(`config.ts:1893`, `:2173`) and the auto-compaction scenario is about qwen's DEFAULT
ladder. `QWEN_CODE_NO_RELAUNCH=true` stops the CLI re-spawning itself, which would
otherwise put a wrapper process between the harness and the agent.

## The MCP probe — the REAL app in front of the REAL qwen

`apps/server/src/ru-code/tests/qwen/real-acp/mcpProbe/` (`mcpProbeRig.ts` = the driver,
`mcpProbe.e2e.test.ts` = the cases and their assertions) with its fakes in `src/mcpProbe/`.
Where the capture above talks to qwen directly, the probe goes through ALL of the app: one case
boots `apps/server/dist/bin.mjs` in a sandbox HOME, configures MCP servers over `/ws` with the
web's own `orchestration.dispatchCommand` payloads, starts turns, and lets the app's decider →
SQLite → overlay writer → spawn builder → (warm pool) → qwen path run untouched. What the rig
owns:

| piece           | file                            | what it is                                                                                                                                |
| --------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| CLI proxy       | `src/mcpProbe/cliProxy.mjs`     | the app's `RU_CODE_CLI_JS`: runs the real bundle with the app's argv/env/cwd, records everything, and applies a knob's explicit transform |
| fake MCP, stdio | `src/mcpProbe/fakeMcpStdio.mjs` | n tools, start delay, crash, name length, call delay; logs every message with its parent process                                          |
| fake MCP, http  | `src/mcpProbe/fakeMcpHttp.mjs`  | the same over streamable HTTP; logs headers                                                                                               |
| fake model      | `src/fakeOpenAiServer.ts`       | records every request body; a knob can script tool calls per turn                                                                         |
| clock shift     | `src/mcpProbe/clockShift.cjs`   | `Date.now()` + N in the app server only (the 30-min TTL case)                                                                             |

**The four angles of every case** (under `<out>/<case>/`):

1. **what we wrote** — `cli/proc-*/meta.json` (argv, env, cwd), `settings.jsonl` (the overlay's
   bytes, sha, mode, inode at exec, at `session/new|load`, before the app hears each answer, and on
   every change), `wire.jsonl` (the ACP wire both ways);
2. **what qwen reports** — `probes.jsonl` (`qwen/status/workspace/mcp`, `…/mcp/tools`,
   `…/session/context_usage {detail:true}`, asked by the proxy with its own ids — never seen by
   the app), `stderr.log` (first 4 MiB), `stderr-bytes.jsonl` (per chunk: bytes qwen wrote so
   far, and `pending` — bytes the APP has not read yet, held by the proxy's own
   `process.stderr`: on POSIX Node queues an unread pipe in the writer and does not block; on
   Windows Node makes a pipe stderr blocking — not measured here, the rig runs on Linux),
   `qwen-debug/*.txt` (qwen's debug log);
3. **what each MCP server received** — `mcp-local.jsonl`, `mcp-remote.jsonl`, … (every message,
   and whether qwen or the app's own monitor sent it);
4. **what the model got** — `model-requests.jsonl` (every request body).

`summary.json` reduces them to facts; `run-meta.json` holds the knobs, the app HEAD, the bundle,
the commands sent, the server keys qwen got (`serverKeys`), a reinstall's app catalog before and
after (`mcpSnapshots`) and the teardown (strays killed by PID).

**Knobs.** A case is `ProbeKnobs` (`mcpProbeRig.ts`): one change against the baseline (LOCAL
50 tools answering after 25 s, REMOTE 50 after 4 s, cold spawn, prompt held 35 s). Every knob is
explicit and recorded; a case that sets none gets exactly what a user gets. To add one: add the
field to `ProbeKnobs`, apply it in `runProbe` (app side: a `dispatch` payload the web sends;
qwen side: a `PROBE_TRANSFORM` key handled in `cliProxy.mjs`, which logs before/after in
`transforms.jsonl`), then write the case with `knob(name, purpose, delta)` and its `CHECKS`
entry. To add a fake behaviour: add an argv flag to the fake (the argv is what a user types
into the app's form, so it travels the app's whole path) and a `FakeServerKnobs` field.

The rig never assumes how the app keys a server for qwen: the proxy finds each server in the
overlay by a string only its entry holds (`PROBE_SERVER_ROLES`), records the key the app wrote
(`cli/proc-*/roles.json`, `summary.serverKeys`), and fills `serverKeyToken(role)` in a knob's
transform with it; model scripts are built from those observed keys. `appEnv` sets env on the
APP SERVER (how a case turns on the app's `QG_` switches, `apps/server/src/ru-code/qwen/acpSwitches.ts`,
importing their names).

S99 knobs for real conditions the app meets: `answerChunks` (the fake model streams every answer
in N chunks, as a real model streams a long one), `killQwenOnTurn` (qwen is SIGKILLed while that
turn's model request is in flight — a crash / OOM kill; the proxy then dies the way qwen died, so
the app sees what it would see), `previousRelease` (the run starts on an OLDER RELEASE — a copy
of the built server with another shipped built-in list — which is configured, stopped, and
replaced by the real build on the same data: a reinstall).

The S94 cases (P-01 … P-108) are diagnostics of qwen itself: each sets its levers through its
own explicit knobs (a transform, a child env), never through app settings — they mean the same
whatever the app's defaults are.

## What it is NOT

- Not the app's ACP client. `src/acpClient.ts` is a few hundred lines of
  newline-delimited JSON-RPC that shares no parsing, no dispatch and no assumptions with
  `effect-acp` / `QwenAcpSessionRuntime` — it is the oracle for that client's fake, so
  sharing a runtime would let one bug hide the other. It is plain Node for the same
  reason.
- Not a re-implementation of the model backend. `src/fakeOpenAiServer.ts` is ported
  **verbatim** from qwen-code `integration-tests/fake-openai-server.ts` @ v0.21.1,
  license header kept, with two marked additions: an HTTP-failure arm (upstream can only
  answer 200, and the `/compress` failure scenario needs the summariser's call to fail at
  the transport) and one `exactOptionalPropertyTypes` shape fix.
- Not a golden corpus. It captures on demand and asserts against the fake's builders.
  The committed byte-verbatim corpus of qwen's **on-disk transcripts** is a different
  artefact and lives in
  `ru-code-packages/packages/qwen-cli-transcript-core/tests/goldens/`, with its own
  re-harvest ritual.
