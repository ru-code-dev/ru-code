# mcp-probe

A self-contained, throwaway probe that proves the planned **MCP-management engine
contract** works against the **real qwen binary** (0.13.1) — *before* we build the
CQRS/projection/reactor subsystem described in `ru-fork-instrumental/changes/mcp/plan.md`.

The engine's whole approach is: drive qwen's MCP servers from outside via a
**settings overlay** (`QWEN_CODE_SYSTEM_SETTINGS_PATH`) plus an **allowlist**
(`--allowed-mcp-server-names`), never touching the user's own `~/.qwen` config.
This probe validates exactly that, end to end.

## Run it

```bash
pnpm install          # once, from repo root — fetches the MCP SDK (catalog dep)
node ./mcp-probe/test.js
```

`qwen` must be on `PATH` (override with `QWEN_BIN=/path/to/qwen`). The SDK powers the
HTTP-transport and monitor cases; the stdio-only cases still run if you skip the install
(those cases just report `SKIP`). The MCP SDK is pinned in the workspace **catalog**
(`@modelcontextprotocol/sdk`), the same dependency the production supervisor will use.

Then **paste the full stdout back**. On success the last line reads:

```
RESULT: GO — overlay + allowlist + per-tool + http + env-expansion + trust all hold; monitor + model confirmed.
```

## What each case proves

**Deterministic cases (no model/API key) — the GO/NO-GO signal.** These boot an
ACP session (which builds qwen's tool registry during `config.initialize`, *without*
calling the model), then read qwen's debug log — `ToolRegistry created: [...]` —
to see exactly which `mcp__<server>__<tool>` entries qwen registered.

| Case | Goal | Oracle |
|---|---|---|
| **D0** | overlay servers are reachable | `qwen mcp list` → alpha+beta Connected |
| **D1** | add our servers + discover under trust | registry has all 4 tools (`mcp__alpha__echo/ping`, `mcp__beta__add/multiply`) |
| **D2** | remove a server from a project | `--allowed-mcp-server-names alpha` → no `mcp__beta__*`, beta never spawned |
| **D3** | ignore a pre-existing user server | a `decoy` in the project's own `.qwen/settings.json` → no `mcp__decoy__*` |
| **D4** | **enable only 1 of 2 tools** (`excludeTools`) | `mcp__alpha__echo` registered, `mcp__alpha__ping` **absent** → model cannot call ping |
| **D5** | whitelist 1 tool (`includeTools`) | `mcp__alpha__ping` registered, `mcp__alpha__echo` **absent** |

**Transport, env-expansion, and fallback:**

| Case | Goal | Oracle |
|---|---|---|
| **H1** | **remote (http) server via overlay** + per-tool on http | a real streamable-HTTP MCP server (SDK) configured by `httpUrl` connects; `mcp__remote__weather` registered, `mcp__remote__news` excluded. This is the path the ACP array *cannot* carry. |
| **V1** | qwen expands `${VAR}` in our overlay | overlay env `${PROBE_INJECTED_VALUE}` arrives at the server already expanded |
| **F1** | **kill-switch fallback** (`MCP_ENGINE_USE_OVERLAY=false`) | stdio passed via the ACP `session/new` array registers; an http entry is silently dropped; the array has **no** per-tool field → in this mode the UI must gray out remote servers + tool checkboxes |

**Folder-trust matrix** — why we disable trust, and that we have an independent lever:

| Case | Goal | Oracle |
|---|---|---|
| **T2** | the trust gate is real | feature ON + folder `DO_NOT_TRUST` → **zero** mcp tools (this is why our overlay turns trust off) |
| **T3** | independent lever works | feature ON + folder `TRUST_FOLDER` (via `QWEN_CODE_TRUSTED_FOLDERS_PATH`) → mcp tools available again |

**Monitor reprobe** — previews the production supervisor (`monitor.mjs`, SDK client,
connect → `listTools` → close, no held connection):

| Case | Goal |
|---|---|
| **P1** | probe a stdio server → online + tools |
| **P2** | probe an http server → online + tools |
| **P3** | a broken server → offline; reprobing a good one twice stays stable |

**Real-model query cases** — end-to-end corroboration. Auto-run if a model is
available (precheck **M0**); otherwise they `SKIP` cleanly — the probe never hangs.

| Case | Goal |
|---|---|
| **M1** | the allowed tool actually executes (real `tool_call` + server `CALL echo`) |
| **M2** | the **disabled** tool is unusable — told to call `ping`, it never reaches the server |
| **M3** | multiple real invocations (`add`, then `multiply` on beta) |

The deterministic D*/T* cases decide GO/NO-GO. Per-tool filtering is proven *both*
deterministically (D4/D5: the tool is absent from the registry, so the model can't
see it) *and* behaviourally when a model is present (M2: a real call attempt never
lands). No `PROBE_WITH_MODEL` flag needed — model cases self-detect.

## How it works

- `servers/mcp-server.mjs` — one parametrized, dependency-free fake MCP stdio
  server. Identity + tool set come from env (`PROBE_SERVER_NAME`, `PROBE_LOG`).
  It appends every protocol event (`START`, `LIST`, `CALL`, …) to its log file.
  A `START` line proves qwen spawned the server; its absence proves it was filtered.
- `test.js` — per case: writes an overlay JSON, points
  `QWEN_CODE_SYSTEM_SETTINGS_PATH` (and, for registry capture, `QWEN_RUNTIME_DIR`)
  at scratch paths, runs qwen, then asserts against **two oracles**: qwen's own
  registry debug log and our fake servers' audit logs.
- `.run/<case>/` — per-run scratch (overlays, logs, `runtime/`). Gitignored.

## If something fails

Inspect `mcp-probe/.run/<case>/logs/*.log` and the `overlay.json` for that case,
then paste them back along with the probe's stdout. Each failure line already
includes the decisive counts (e.g. `alpha reached=true beta reached=true`).
