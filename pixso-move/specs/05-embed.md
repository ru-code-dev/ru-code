# Task 5 — Embed the processor into the server runtime

Compose the processor (task 4) into the server's Effect runtime (task 3) so they share one process,
one sqlite connection, and one logger. Wire `POST /ingest` to `notify()` the processor for
low-latency pickup. TDD, 100% coverage for the wiring.

## What gets wired

```
makeServerLayer
 ├─ persistence (SqlitePersistenceMemory | layerConfig)   ← single sqlite, single writer
 ├─ ServerLoggerLive
 ├─ NodeStoreLive, ResultStoreLive                        (task 3 services)
 ├─ ProcessorLive                                         (NEW — builds makeProcessor)
 │    deps = ProcessorDeps built from NodeStore + ResultStore
 │    started on layer acquisition; stopped on release (scoped)
 └─ HttpRouter.serve(routes)  ← ingest handler resolves Processor and calls notify
```

## File budget
| Path | Responsibility | LOC |
|---|---|---|
| `server/src/services/processorLive.ts` | build `ProcessorDeps` from stores + `AcpRunner`; `ProcessorLive` scoped layer | ~45 |

(`Processor` tag and `AcpRunnerLive` come from `@pixso-move/processor`; `NodeStore.listNodeIds`/
`getForProcessing` already exist from task 3 — no new store methods needed.)

## ProcessorLive layer (`server/src/services/processorLive.ts`)
```ts
export const ProcessorLive = Layer.scoped(Processor, Effect.gen(function* () {
  const nodeStore = yield* NodeStore;
  const resultStore = yield* ResultStore;
  const acp = yield* AcpRunner;                  // AcpRunnerLive in prod; provided fake in tests
  const deps: ProcessorDeps = {
    listNodeIds:      nodeStore.listNodeIds,
    getForProcessing: nodeStore.getForProcessing,
    reconcile:        resultStore.reconcile,
    claimNextPending: resultStore.claimNextPending,
    complete:         resultStore.complete,
    fail:             resultStore.fail,
    recoverInFlight:  resultStore.recoverInFlight,
    acp,
  };
  const processor = yield* makeProcessor(deps, { config: processorConfig });
  yield* processor.start;                        // recover + arm timer
  yield* Effect.addFinalizer(() => processor.stop);
  return processor;
}));
```
- `Processor` is the `Context.Service` tag from `@pixso-move/processor`. The ingest handler resolves
  it to call `notify`. SQL stays solely in task-3 stores.

## Ingest → notify
In `http/ingest.ts` (task 3), after a successful `NodeStore.insert`:
```ts
const processor = yield* Processor;
yield* processor.notify;           // fire-and-forget pickup; never fails the request
```
- `notify` is non-blocking and self-contained (its own catch). If the designer is unconfigured,
  the tick reconciles nothing for them — harmless. The HTTP response returns `{ nodeId }`
  regardless of processing outcome.

## AcpRunner provisioning
- **Production**: `AcpRunnerLive` (task 4) provided into `makeServerLayer`, reading `cliJs`/`cwd`/
  env from `ServerConfig` (extend `ServerConfig` with `cliJs`, `cliHome?` fields; default `cliJs`
  to a config flag `--cli-js`).
- **Tests**: provide a `FakeAcpRunner` layer instead → end-to-end-in-memory without qwen.

## TDD — tests first (100%)
Build a full in-memory app layer: `SqlitePersistenceMemory` + stores + `ProcessorLive` (with
**FakeAcpRunner**) + routes + test logger + `ServerConfig.layerTest`.

- **embed smoke**: layer builds, processor `start` ran (recovery executed), timer armed; layer
  release stops the processor (no leaked fiber — assert finalizer ran).
- **ingest triggers processing**: `POST /ingest` for a **configured** designer → 200 `{ nodeId }`;
  after allowing the tick to run (drive `runTickOnce` or advance TestClock), `GET /processing-data?
  nodeId=…` shows the configured tags transitioning to `done` with FakeAcpRunner's text.
- **unconfigured designer**: `POST /ingest` for an unknown designer → stored, but
  `processing-data` stays empty (no rows reconciled). Server fine.
- **notify never breaks ingest**: inject a processor whose `notify` would error → ingest still
  returns 200 (notify is contained). Assert `logError` captured, response unaffected.
- **shared writer**: ingest + processing both write the same in-memory DB without error
  (single-writer guarantee holds because one runtime).

## Acceptance
- [ ] One process, one sqlite, one logger; processor starts/stops with the server layer.
- [ ] Ingest notifies the processor; pickup is near-immediate for configured designers.
- [ ] A failing `notify` never affects the HTTP response.
- [ ] End-to-end in-memory test (ingest → processed → readable) passes with a fake ACP runner.
- [ ] `tsc`/oxlint clean; wiring covered 100%.
