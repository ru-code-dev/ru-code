# MCP management — specification set (current)

This folder is the **authoritative, code-derived** documentation for the ru-fork MCP
(Model Context Protocol) management feature. It was reconstructed by reading the current
working tree line-by-line (the code is the source of truth; the UI/UX and server behaviour
described here are the *desired* final state). The older planning/progress docs were moved to
[`../legacy/`](../legacy/) and are superseded by these.

| Document | What it answers |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | How the whole thing is structured: the event-sourced CQRS spine, the MCP aggregates, the `mcp-core` / server / web layering, the dependency graph, and where every concern lives. |
| [`WORKING-LOGIC.md`](./WORKING-LOGIC.md) | Every runtime flow, drawn as ASCII flow/state diagrams: monitoring sweep, probe lifecycle, the eager-vs-load probe decision, edit-lock, the turn-start overlay/restart gate, the built-in migrator, secret split/GC/keep, varValues prune, warn-on-impact, manual recheck. |
| [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) | The exhaustive reconstruction spec — every contract field, command/event, SQL column, function signature, and algorithm — detailed enough to recreate the feature 1:1. |
| [`DATA-MODEL.md`](./DATA-MODEL.md) | Companion reference: the full schema catalogue (contracts), the three SQL tables, and the key-derivation functions (`configCacheKey`, `dedupHash`, `overlayFingerprint`, secret names). |
| [`GLOSSARY.md`](./GLOSSARY.md) | Companion: every domain term (template, var, binding, overlay, dedup hash, watched project, …) defined once. |
| [`AUDIT.md`](./AUDIT.md) | The earlier production-readiness review: what is good, and every concrete issue with file:line citations and before/after fixes. (For the **current** gap list see `GAP-ANALYSIS.md`.) |
| [`GAP-ANALYSIS.md`](./GAP-ANALYSIS.md) | **Current (2026-06-14).** The feature-level gap analysis — "what are we still missing", from two independent source audits + the test state. Tiered: real correctness/security gaps, robustness/edge cases, UI gaps, operational gaps, test gaps, and what's solid. |
| [`TESTING.md`](./TESTING.md) | **Current.** State of the server-side test suite (18 MCP files, all green): what each file covers, coverage numbers, the fixes landed this round, harness patterns, and the honest scope (qwen still stubbed). |
| [`HANDOFF.md`](./HANDOFF.md) | **Current.** Session resume anchor: where things stand, what to do next (the Tier-1 gaps), and the hard constraints. |
| [`FIXES.md`](./FIXES.md) | The actionable fix plan for the earlier audit + robustness review (R1–R5): each fix with exact location, before→after, risk, and verify step. |
| [`improvments-banch-1.md`](./improvments-banch-1.md) | **Implemented.** The branch-1 plan: the two binding-status fixes (F1/F2) + B1–B6 + all reviewed findings (bugs, UI gaps, design calls) with decisions captured and exact before→after. Kept as the build record; the current behaviour it describes now lives in the docs above. |
| [`improvments-banch-2.md`](./improvments-banch-2.md) | **Next (planned).** Four web-only var-model edge cases: «требует настройки» count-badge+tooltip, the catalog-incomplete binding state («требует настройки в каталоге»), red-marking unfilled required vars in the catalog detail, and derived read-only shipped-value template vars. Begins with a gate of the un-gated unified-card/var-model work. |
| [`improvments-banch-3.md`](./improvments-banch-3.md) | **Mostly implemented (2026-06-14).** 11-item correctness/security/UX pass — see its top "IMPLEMENTATION STATUS" block. Done: #1 backfill, #2 config-uniqueness + built-in skip, #4 secret encryption, #5 readable UI toasts, #6 trust (full chain), #8 var validation, #9 missing-secret, #10 64-bit hash, server-side rejected-command logging. **Remaining:** #11 watchedProjects. (#4 ephemeral-overlay delete is now done — see branch-4.) Tests in `apps/server/tests/ru-fork/mcp/branch3*.ts`. |
| [`improvments-banch-4.md`](./improvments-banch-4.md) | **Implemented + green (2026-06-14).** Ephemeral overlay deletion (#4): the plaintext-secret overlay is deleted on every spawn settle via `Effect.ensuring` in the reactor, made reliable by a new **inner CLI start timeout** (`ACP_SESSION_START_TIMEOUT_MS` + `timeoutOrElse`) that fails a wedged boot, plus **sweep-on-start** and **sweep-on-shutdown**. Literal before/after for all 6 changes + a 13-test guarantee matrix (deletion on success/error/timeout/reuse/start/shutdown; deletion ⊥ apply; write-finalized-before-spawn ordering). `test:fast` 896 pass. |

## One-paragraph orientation

A **catalog** of MCP server *templates* (command/args/headers with `${VAR}` holes + a `vars` block) is
authored through event-sourced commands and projected to SQLite. Every var is **required** and is one
of two kinds: a **catalog value** (shared, filled in the catalog — empty ⇒ «требует настройки») or a
**per-project hole** (no catalog value, filled per binding — its presence makes the server a «шаблон»,
probeable only once a project supplies the value). A project **binds** a catalog server by supplying
per-project var *values* only — never config, so the server's identity is the catalog's and cannot be
forked; a server can be turned off catalog-wide via an `enabled` flag without losing its bindings. A
**supervisor** keeps an in-memory registry of live instances (deduplicated by resolved-config hash) and
*probes* them (connect → listTools → close) to surface status + discovered tools (and a server's
self-reported description/docs-link, back-filled onto the catalog when empty), cached per authored
config. At **turn-start**, the server writes a per-project qwen *settings overlay* (the single source
qwen reads for MCP) and re-spawns the ACP session only when that overlay's fingerprint changed. Secrets
live exclusively in the `ServerSecretStore` as refs — never in events, projections, or the client. The
catalog and project lists share one **item card** + one **control cluster** (refresh · edit · delete ·
on/off), so they look and behave identically.
