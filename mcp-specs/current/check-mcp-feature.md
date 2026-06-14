# How to verify the MCP feature works end-to-end (manual runbook)

**You run this. I never run qwen or the probe — it lives on another machine.** This is the manual
gate that proves our MCP overlay actually drives the **real qwen 0.13.1 binary** (the one thing unit
tests can't cover, because qwen consumes the overlay out-of-band).

---

## What the probe proves

`mcp-probe` writes a per-project qwen settings overlay, spawns `qwen --acp`, drives an ACP
`session/new`, and then checks **two independent oracles** that qwen actually loaded our overlay:

1. **qwen's own tool registry log** — qwen writes `ToolRegistry created: [...]` during
   `config.initialize()`; the probe parses it and asserts the expected `mcp__<server>__<tool>` set.
2. **Each fake server's audit log** — the bundled fake MCP servers append `START` / `LIST` / `CALL`
   events, so the probe confirms the server was actually spawned, listed, and (for model cases) called.

It exercises every axis of the contract: discovery under trust, the allow-list
(`--allowed-mcp-server-names`), per-tool include/exclude, HTTP transport, `${VAR}` env expansion,
folder-trust, the monitor reprobe, and (with a real API key) real model tool calls.

**Pass ⇒ qwen honors our overlay shape.** See "Known limits" for what it does NOT prove.

---

## Prerequisites

- **Node.js** (ESM-capable).
- **The `qwen` binary** on `PATH`, or its path in `QWEN_BIN`. Must be **0.13.1** (the version this
  overlay contract is aligned to).
- One `pnpm install` at the repo root (fetches `@modelcontextprotocol/sdk` for the http/monitor cases).
- Optional: a real model API key in the environment if you want the model cases (M*) to run instead
  of skip — the probe auto-detects (precheck `M0`); without it those cases are skipped, core still runs.

## Run it

From the **repo root** (`/mnt/mac/Users/user/WORKSPACE/Projects/experements/ru-code`):

```bash
pnpm install            # once
node ./mcp-probe/test.js
```

Override the binary if it's not on `PATH`:

```bash
QWEN_BIN=/absolute/path/to/qwen node ./mcp-probe/test.js
```

You can run it repeatedly; each case uses its own scratch dir under `mcp-probe/.run/<case>/`
(gitignored).

## Read the result

Per-case lines:
- `✓ [D1] add + discover under trust — PASS: all 4 tools registered`
- `• [M1] … — SKIP` (optional case skipped, e.g. no API key)
- `✗ [D2] allowlist removes a server — FAIL: …` (decisive counts inline)

Final verdict (last line) + exit code:
- `RESULT: GO — …` → exit `0`. Everything holds. ✅
- `RESULT: GO (core) — …` → exit `0`. Core contract holds; a non-core (monitor/model) case failed.
- `RESULT: NO-GO — …` → exit `1`. A core case failed — the overlay/qwen coupling is broken.
- Probe crashed → exit `2`.

## When a case fails

1. Open `mcp-probe/.run/<case>/overlay.json` — confirm the overlay we wrote is the shape you expect.
2. Open `mcp-probe/.run/<case>/logs/*.log` — the fake server audit + qwen runtime logs.
3. The failure line already prints the decisive counts (e.g. `betaSpawned=true registry=[...]`).
4. Paste the failing line + those two files back here and I'll diagnose against the source.

A `NO-GO` after a **qwen upgrade** almost always means the overlay schema drifted — qwen changed how
it reads `mcpServers` / the settings file / the allow-list flag. That's exactly the "trusts qwen
blindly" risk this runbook exists to catch.

---

## Known limits (what the probe does NOT prove yet)

The probe tests qwen offline (spawn → read its registry log + the fake servers' audit logs → close).
It does **not**:
- Exercise our production session-runtime path (it's a standalone ACP client, not our server).
- Explicitly assert cross-project isolation (two projects can't see each other's servers) — implied,
  not tested.

**Important (verified in qwen 0.13.1):** there is **no in-product way** to confirm what qwen loaded.
qwen's ACP `session/new` response returns only `{sessionId, models, modes, configOptions}` — it does
**not** report loaded MCP servers or tools (`acpAgent.ts:196-215`), and our `AcpSessionRuntime` isn't
even given the overlay's server names. So the server genuinely cannot compare "what qwen loaded" vs
"what we sent" over ACP. **qwen's debug registry log (what this probe reads) is the only oracle that
exists** — which is exactly why this manual runbook is the verification gate, not an automated
in-product check. (The durable fix is an upstream qwen change to expose loaded-MCP status; see
`improvments-banch-3.md` §3, option C.)

Proposed **additive** probe cases (in `improvments-banch-3.md` §3b, not yet applied): a negative
"allow-listed server name that doesn't exist → none of its tools register" case, and an explicit
two-project isolation case. **Proposals — agree before I touch the probe.**

---

## One-line summary

`pnpm install && node ./mcp-probe/test.js` → look for `RESULT: GO` and exit `0`. That confirms real
qwen 0.13.1 loads our overlay, applies the allow-list + per-tool policy, expands vars, and discovers
the right tools. Anything else, send me the failing case's `overlay.json` + `logs/`.
