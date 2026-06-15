# pixso-move — specs

> **Implementation status:** see [`../STATUS.md`](../STATUS.md). Tasks 1, 2, 3, 6–8 are **done and
> green** (server-side 100% coverage); Tasks 4–5 (real processor + embed) are **deferred**. STATUS.md
> also records where the implementation deviates from these specs (e.g. `GET /node?id=`, theme via
> `pixso.clientStorage`, capped display preview).


Design-handoff pipeline for **Pixso** (a Figma-style design tool) where the corporate
environment **blocks all Pixso APIs**. The only way to extract design data is a **plugin**
running inside Pixso. Raw node JSON is useful on its own, but we **enrich it with an LLM**
(qwen, driven over ACP) to produce more usable, developer-facing output.

Three actors, one data spine:

```
 ┌──────────┐   POST /ingest          ┌──────────┐   reconcile+claim    ┌────────────┐
 │  PLUGIN  │ ──{designerId,preview,  │  SERVER  │ ───────────────────▶ │ PROCESSOR  │
 │ (Pixso)  │     nodes}────────────▶ │ (HTTP +  │   (embedded in       │ (effect-acp│
 │          │                         │  sqlite) │    server runtime)   │  → qwen)   │
 └──────────┘ ◀── GET /nodes …        └──────────┘ ◀── writes results ──└────────────┘
   designer        developer reads          sqlite (nodes, processing_results)
```

- **Plugin** (designer): selects one frame, sends `{designerId, preview, nodes}` to the server.
- **Server** (storage + read API): validates, persists to sqlite, exposes key-gated GET endpoints.
- **Processor** (enrichment): for *configured* designers, runs configured prompts through qwen and
  writes status-tracked results that developers query.

## Why this design

- Pixso APIs are blocked → a **plugin is the only extraction path**.
- Raw nodes are useful, but **LLM enrichment** (component specs, code, summaries — whatever a
  prompt asks) makes them more usable.
- A designer carries a **key (`designerId`)** — generates/saves it once, shares it with
  developers so they can read that designer's nodes and enriched results.

## This is built FRESH on ru-fork architecture

The reference product at `…/experements/pixso-move` is **someone else's**. We borrow *ideas and
utility helpers only* (node serialization, poll+notify loop, atomic claim, code-fence extraction).
Everything else — server, plugin UI, processor — is built from scratch on **ru-fork best
practices**: Effect + effect-platform server, ru-fork web components/styles for the plugin UI,
and ru-fork's own `effect-acp` package for the CLI/ACP integration.

## Layout

```
pixso-move/
  contracts/   @pixso-move/contracts   — effect Schema: requests/responses/rows + tagged errors
  server/      @pixso-move/server       — Effect HTTP + node:sqlite; embeds the processor
  processor/   @pixso-move/processor    — drives effect-acp; reconcile→claim→ACP→store loop
  plugin/      @pixso-move/plugin       — Pixso plugin: code.ts (sandbox) + iframe UI (vendored ru-fork kit)
  specs/       these documents
```

## Spec index

| # | Spec | Covers |
|---|------|--------|
| — | [conventions.md](./conventions.md) | Lint, typecheck, test, TDD/coverage policy, import style, Effect idioms — **read first, applies to every task** |
| — | [00-overview.md](./00-overview.md) | Vision, full data model, contracts, endpoint table, glossary |
| 1 | [01-scaffold.md](./01-scaffold.md) | 4 packages, package.json, tsconfigs, workspace wiring, effect-acp confirmation |
| 2 | [02-contracts.md](./02-contracts.md) | effect Schema for all requests/responses/rows + tagged errors |
| 3 | [03-server.md](./03-server.md) | sqlite layer + migrations (2 tables), HTTP routes, logger, config, bootstrap |
| 4 | [04-processor.md](./04-processor.md) | effect-acp client wrapper, reconcile+claim repo, run loop, crash recovery, config |
| 5 | [05-embed.md](./05-embed.md) | compose processor into server runtime, `notify()` on ingest |
| 6 | [06-plugin-build.md](./06-plugin-build.md) | two vite configs, manifest, vendor UI kit + theme + `cn` |
| 7 | [07-plugin-code.md](./07-plugin-code.md) | selection validation, node serialize, `exportAsync` 1× preview, postMessage bridge |
| 8 | [08-plugin-ui.md](./08-plugin-ui.md) | settings / preview / send screens, clientStorage, fetch to server |
| 9 | [09-end-to-end.md](./09-end-to-end.md) | typecheck/lint/coverage gates; manual smoke (user runs Pixso + qwen) |

## Hard rules (non-negotiable, from the product owner)

1. **All server-side code is covered by tests — 100% coverage — written TDD (tests first).**
2. **Lint + typecheck identical to ru-fork web/server. Zero lint errors, zero typecheck errors.**
3. **Server logs everything — `logError` / `logDebug` only** (no info/warn). Especially the
   processing steps, so we can see what failed and what worked. **The server must never crash.**
4. Processing has **full status tracking** (pending/processing/done/error, attempts, error text,
   timestamps) for observability, retry, and crash recovery.
5. **Production-grade, senior-level, DRY.** Every authored source file is **≤150 LOC**, single
   responsibility, well-decomposed. Cross-cutting logic is defined **once** and reused (shared
   tsconfig/vitest base, one error→response mapper, one route wrapper, one timestamp source).
   Proven upstream infra (e.g. the `node:sqlite` client) is **vendored verbatim** under `vendor/`,
   isolated and exempt — never rewritten. See [conventions.md](./conventions.md) §2.
