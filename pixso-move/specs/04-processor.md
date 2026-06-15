# Task 4 — Processor (`@pixso-move/processor`)

Watches new node records from **configured** designers, runs each configured prompt through qwen
over ACP (via `effect-acp`), writes status-tracked rows. **Never crashes.** TDD, 100% (minus the one
`*.integration.ts` spawn-glue file). Every authored file ≤150 LOC.

## File budget
| Path | Responsibility | LOC |
|---|---|---|
| `src/types.ts` | `ProcessorConfig`, `ConfigEntry`, `ProcessorDeps`, `AcpRunner`, `AcpRunError`, `ClaimedJob`, `ProcessorOptions` | ~50 |
| `src/config.ts` | the operator-edited `processorConfig` value | ~20 |
| `src/prompt.ts` | `buildPrompt(input)` — pure | ~25 |
| `src/extract.ts` | `extractText(raw)` — pure (code-fence unwrap) | ~25 |
| `src/reconcile.ts` | `computeReconcileRows(config, nodesByDesigner)` — pure | ~30 |
| `src/drain.ts` | `runOneJob(deps, job)` — the single contained unit | ~45 |
| `src/engine.ts` | `makeProcessor(deps, options)` — loop, notify, recover, timer | ~95 |
| `src/processor.ts` | `Processor` service tag + `Processor` shape | ~20 |
| `src/acp/collect.ts` | `accumulateDelta(buf, notification)` — pure delta reducer | ~25 |
| `src/acp/handshake.ts` | initialize/authenticate/createSession param builders + stopReason/error mapping — pure | ~30 |
| `src/acp/acpRunnerLive.integration.ts` | spawn qwen + `layerChildProcess` + run → `AcpRunner` | ~80\* |
| `src/index.ts` | public exports | ~12 |

`*` = coverage-excluded (only the real-process spawn glue). `tests/` mirrors the pure modules.

> **No dependency on `@pixso-move/server`.** The processor owns the `ProcessorDeps` interface; the
> server satisfies it at embed time (task 5). This avoids a cycle and keeps SQL solely in the
> server's stores.

## Injected dependencies (`types.ts`)
```ts
export interface ProcessorDeps {
  readonly listNodeIds: (d: DesignerId) => Effect.Effect<ReadonlyArray<NodeId>>;
  readonly getForProcessing: (n: NodeId)
    => Effect.Effect<{ nodeId: NodeId; rootName: string; nodesJson: string } | undefined>;
  readonly reconcile: (rows: ReadonlyArray<{ designerId; nodeId; resultTag }>) => Effect.Effect<number>;
  readonly claimNextPending: Effect.Effect<ClaimedJob | undefined>;
  readonly complete: (id: string, result: string) => Effect.Effect<void>;
  readonly fail: (id: string, error: string) => Effect.Effect<void>;
  readonly recoverInFlight: Effect.Effect<number>;
  readonly acp: AcpRunner;
}
export interface AcpRunner {
  readonly run: (input: { prompt: string }) =>
    Effect.Effect<{ text: string; stopReason: string }, AcpRunError>;
}
```
The tiny `AcpRunner` seam is what makes the engine testable and isolates all `effect-acp` detail.

## Pure helpers (fully tested)

### `prompt.ts`
`buildPrompt({ prompt, rootName, nodesJson }): string` — configured prompt + output rule ("return
the result only") + payload (`rootName` then ```json fenced `nodesJson`). Deterministic. Borrowed
*shape* from the reference's prompt-builder; reimplemented.

### `extract.ts`
`extractText(raw): { text: string }` — if the result is a single fenced block, return its body;
else the trimmed whole. Borrowed *idea* (code-fence extraction) from the reference.

### `reconcile.ts`
`computeReconcileRows(config, nodesByDesigner): Array<{ designerId; nodeId; resultTag }>` — cross
each configured designer's `nodeIds` with that designer's `resultTag`s. Pure; the engine fetches
`nodesByDesigner` via `deps.listNodeIds` and passes `deps.reconcile` the result.

### `acp/collect.ts`
`accumulateDelta(buf: string, n: SessionNotification): string` — appends `n.update.content.text`
when `n.update.sessionUpdate === "agent_message_chunk"` && `content.type === "text"`; ignores other
update kinds. Pure reducer over the `effect-acp/schema` union.

### `acp/handshake.ts`
Pure builders: `initializeParams()`, `authenticateParams()` (`{ methodId: "openai" }`),
`newSessionParams(cwd)`, and `mapAcpError(e: AcpError): AcpRunError`,
`mapStopReason(res): string`. (Constants verified against `AcpSessionRuntime.ts` + `config.ts:52`.)

## `drain.ts` — the contained unit
```ts
export const runOneJob = (deps: ProcessorDeps, job: ClaimedJob) => Effect.gen(function* () {
  const node = yield* deps.getForProcessing(job.nodeId);
  if (!node) { yield* deps.fail(job.id, "node missing"); return; }
  const prompt = buildPrompt({ prompt: /*from config via engine*/, rootName: node.rootName, nodesJson: node.nodesJson });
  const res = yield* deps.acp.run({ prompt });
  yield* deps.complete(job.id, extractText(res.text).text);
  yield* Effect.logDebug("job done", { nodeId: job.nodeId, resultTag: job.resultTag, stopReason: res.stopReason });
}).pipe(Effect.catchAllCause((cause) => Effect.zipRight(
  Effect.logError("job failed", { nodeId: job.nodeId, resultTag: job.resultTag, cause: Cause.pretty(cause) }),
  deps.fail(job.id, Cause.pretty(cause)))));   // ANY failure/defect → error row, never escapes
```
> The job's prompt text comes from the config entry matching `job.resultTag`+`designerId`; the
> engine resolves it and passes it in (so `drain` stays pure-of-config-lookup). Adjust signature to
> `runOneJob(deps, job, promptText)`.

## `engine.ts` — the loop
```ts
export const makeProcessor = (deps, options): Effect.Effect<Processor, never, Scope.Scope>
```
`ProcessorOptions = { config: ProcessorConfig; pollIntervalMs?: number /*2000*/ }`.
- **start**: `recoverInFlight` (`logDebug("recovered", { count })`) → fork a `Schedule.fixed`
  timer calling `notify`, interruptible on scope close.
- **runTickOnce**: (1) for each configured designer, `listNodeIds` → `computeReconcileRows` →
  `deps.reconcile`; `logDebug("reconciled", { inserted })`. (2) drain: loop `claimNextPending`;
  resolve `promptText` from config by `resultTag`; `runOneJob(deps, job, promptText)`; until
  `undefined`.
- **notify**: if a tick is in-flight (`Ref<boolean>`), set a "re-run" flag and return; else run a
  tick, then re-run once if flagged. Serializes ticks (reference's poll+notify guard).
- **never-crash**: `runTickOnce` is wrapped `Effect.catchAllCause(logError)` so a tick can't kill
  the timer; `runOneJob` already contains per-job failure; `notify` is self-contained.
- **stop**: interrupt timer, await in-flight.

`processor.ts` exports `Processor = Context.Service<…>("pixso-move/Processor")` with
`{ start; notify; stop; runTickOnce }`.

## Real ACP impl — `acp/acpRunnerLive.integration.ts` (excluded)
The only un-unit-testable file. Assembles the pure helpers into a real runner:
1. spawn `process.execPath [cliJs, "--acp"]` via `ChildProcessSpawner` (`shell:false`, env per
   `CliAcpSupport.ts`: `CLI_HOME`, `NODE_TLS_REJECT_UNAUTHORIZED="0"`).
2. `AcpClient.layerChildProcess(handle)` → `AcpClient.AcpClient`.
3. register `client.handleSessionUpdate(n => Ref.update(buf, b => accumulateDelta(b, n)))`.
4. `initialize` → `authenticate` → `createSession` (using `handshake.ts` builders) → `prompt`.
5. read `buf`; return `{ text, stopReason: mapStopReason(res) }`; map `AcpError` via `mapAcpError`.
Exposed as `AcpRunnerLive` layer. Session-per-job (simple, isolated); child reused across jobs with
idle reap is an allowed later optimization. Because every pure part lives in `collect.ts`/
`handshake.ts`/`extract.ts` (100% tested), this file is thin glue and justifiably excluded.

## TDD — tests first (100% of non-excluded)
Inject a **FakeAcpRunner** (scripted `{text,stopReason}` or fail-on-demand) + the **real stores**
over `SqlitePersistenceMemory` (exercises real claim atomicity), or hand fakes implementing
`ProcessorDeps`.
- **prompt/extract/collect/handshake/reconcile**: enumerated pure cases (fence variants; delta kinds
  appended vs ignored; reconcile crosses only configured designers × their tags; error/stopReason
  mappings).
- **drain**: success→`done`+text; FakeAcpRunner failure→`error` row + `logError`; a thrown defect→
  caught→`error`+loop continues (assert a second queued job still completes); missing node→
  `fail("node missing")`.
- **engine**: reconcile creates rows only for configured designers; multiple tags→multiple rows;
  idempotent across ticks; adding a config entry + re-tick backfills existing nodes; crash recovery
  (`processing→pending` on start, attempts not bumped); notify serialization (no concurrent ticks,
  re-run after); timer fires (Effect **TestClock**, no real sleep); the loop type is `Effect<…,
  never>` (never-fails proof).

## Acceptance
- [ ] Only configured designers processed; multiple tags supported; full lifecycle observable.
- [ ] Crash recovery resumes interrupted work; no job (even a defect) breaks the loop/process.
- [ ] Every step logged (`logDebug` progress / `logError` failures).
- [ ] Each authored file ≤150 LOC; only `*.integration.ts` excluded; `tsc`/oxlint clean; 100%.
