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

Nothing here runs without a built bundle. The gate is one variable:

```bash
export RU_CODE_QWEN_CLI_JS=<qwen build>/dist/cli.js
pnpm --filter @t3tools/server test:real-qwen
```

Without it every case in
`apps/server/src/ru-code/tests/qwen/real-acp/qwenRealCompressionWire.e2e.test.ts`
is **skipped**, so `vp run -r test` never needs a qwen binary.

## Building a bundle (never in place)

The qwen-code checkout is READ-ONLY. Build in a copy:

```bash
QWEN_SRC=/path/to/qwen-code            # the read-only v0.21.1 checkout
BUILD=$SCRATCH/qwen-build              # anywhere outside it

mkdir -p "$BUILD"
( cd "$QWEN_SRC" && tar --exclude=.git --exclude=node_modules --exclude=dist \
    --exclude=bundle -cf - . ) | ( cd "$BUILD" && tar -xf - )

cd "$BUILD"
npm ci                                  # its postinstall also runs the bundle
node dist/cli.js --version              # must print 0.21.1
```

`npm ci` is what makes the bundle possible: the read-only checkout has only a partial
install (its root `node_modules` carries devDependencies, the workspace packages' own
deps are not linked), so `node esbuild.config.js` cannot resolve `jsonc-parser` or
`esbuild-plugin-wasm` there. The copy pays a full install once and then bundles as part
of the same postinstall.

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
