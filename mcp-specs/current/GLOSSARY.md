# MCP management — Glossary

Every domain term, defined once. Cross-references in **bold**.

| Term | Definition |
|---|---|
| **MCP** | Model Context Protocol — the protocol by which an external server exposes *tools* to a coding agent (qwen). |
| **Catalog** | The global set of authored MCP server **templates** (`mcp_catalog_server`). A singleton CQRS aggregate. |
| **Catalog server / template** | One catalog row: a `config` template (command/args/url/headers with `${VAR}` holes) + a `vars` block + identity/lock metadata. Its *status* is not stored on the row — it lives in the **probe cache**. |
| **Binding** | A catalog server attached to a **project** (`mcp_project_binding`). Holds **no config** — only per-project **var values**, an enable flag, a **tool policy**, and an optional timeout. Identity is the catalog's. |
| **Var** | A named value that parameterizes a template. Exported as a process env var (stdio) and usable as `${NAME}`. Every var is **required** (always) and is one of two kinds: a CATALOG value (`perProject: false` — a fixed/shared value filled in the catalog) or a **per-project hole** (`perProject: true` — no catalog value, `value: null`, filled per binding). Flag `secret` stores it in the **secret store**. Has an **origin**. |
| **Required** | Now implicit and always true — every var must resolve to a value. The «обязательно» editor toggle was removed (vars carry `required: true`). Applies at any level: a **catalog**-level required var with no value makes the catalog server incomplete («требует настройки»); a **per-project** one makes the **binding** incomplete. |
| **Per-project var / hole** | A `perProject` var whose value is supplied by each binding — it has no catalog value (`value: null`). Turning «для проекта» on clears and disables the catalog value field. Names of the still-missing ones drive `missingRequiredVars`. |
| **Origin** | `shipped` (declared by a **built-in** template — replaced wholesale on template update) or `user` (added by the user — preserved across updates). |
| **extraArgs** | User-appendable args appended after `config.args`. The escape hatch that lets a user customise a **locked** template without editing its command. |
| **extraHeaders** | Catalog-level extra/override HTTP headers (with `${VAR}` holes) for a **locked** http template — the http analogue of **extraArgs**, merged over `config.headers`. |
| **Locked** | A template whose `command`/`args` are read-only (`locked: true`). The decider rejects a `config` patch for it; the user edits only var values + `extraArgs`. Built-ins are locked. |
| **Built-in** | A shipped template, identified by a stable hidden **builtinId**, reconciled at startup by the **migrator**. Carries a **builtinHash**. |
| **builtinId** | The stable hidden reconciliation key of a built-in (e.g. `"context7"`). Never renamed. `null` for manual servers. Serverid = `srv-builtin-<builtinId>`. |
| **builtinHash** | Content hash of a built-in's shipped definition last applied. Drives "shipped template changed → update". |
| **Migrator** | `McpReactor.reconcileBuiltins` — at startup, adds new built-ins, updates changed ones (by `builtinHash`, via a 3-way merge), and removes dropped ones, all keyed by **builtinId**. |
| **3-way merge** | `buildSyncedBuiltin`: shipped declarations replace; user data (configured values by name, user-origin vars, `extraArgs`) is preserved. |
| **Draft / Patch** | The inbound, **plaintext** form of a server/binding edit. The decider **splits** secrets out of it before emitting an event. |
| **Split** | `McpSecrets.splitServerVars` / `splitBindingVarValues`: replace plaintext secret values with `{ secretRef }` and persist the plaintext in the **secret store**. |
| **keepSecret / keepVarValues** | Signals that a masked secret was left untouched by the client, so the decider must **preserve** the existing stored ref rather than wipe it. |
| **Secret store** | `ServerSecretStore` — the single authority for secret plaintext, on disk as `mcp-var-…` files. Everywhere else: a **ref**. |
| **Ref / secretRef** | `{ secretRef: "<name>" }` — a pointer into the secret store. What events/projections/the client hold instead of plaintext. |
| **Materialize** | Read secret refs back to plaintext (`materializeSecretValues`) — only in-memory, only at probe/overlay time. |
| **Resolve** | `resolveConfig` — expand a template + vars + values into a fully-literal **ResolvedServerConfig** (command/args/env/cwd or url/headers). |
| **Probe** | `probeOnce` — connect to one MCP server, `listTools()`, close. Yields status + discovered tools. Holds no connection. |
| **Supervisor** | `McpSupervisor` — owns the in-memory **registry** of live **instances** and the **sweep** loop. |
| **Instance** | One entry in the supervisor registry, keyed by **dedupHash**, refcounted by **refs**. |
| **Reconcile** | `McpReactor.reconcileNow` → `supervisor.reconcile` — recompute the **desired set** from authored state and diff it into the registry. |
| **Desired set** | The `Map<hash, DesiredInstance>` the reactor computes from catalog defaults + complete enabled bindings. |
| **Ref (instance)** | A string `"<projectId>:<serverId>"` (a binding) or `"catalog:<serverId>"` (the catalog default), naming who references an **instance**. |
| **dedupHash** | `fnv1a(canonicalize(resolved))` — the registry key. Includes the (neutral probe) cwd. |
| **configCacheKey** | `fnv1a(canonicalize({config, effectiveVars, extraArgs}))` — the **probe cache** key; cwd-independent and secret-free, so projects on the default share one. |
| **Probe cache** | `mcp_probe_cache` — persisted status + discovered tools, one row per **configCacheKey**. The source of truth for status; seeds the registry on reconcile. |
| **Sweep** | The 60s loop that re-probes **due** instances of the **watched** project, per the recheck intervals. |
| **Due-gate** | `isSweepDue` / `isProbeDue` — decides whether an instance should be re-probed (never-checked ⇒ never; watched scope; per-transport interval; 0 ⇒ off). |
| **Watched project** | The project the client is currently viewing (`mcp.setActiveProject`). The sweep is scoped to it; `null` ⇒ all (default). |
| **Eager** | A reconcile that **probes** the newly-added instances immediately (a real config change). The startup/hydrate reconcile is **not** eager (no probing on load). |
| **checking** | An orthogonal flag (`inFlight.has(hash)`) — a probe is in flight. Drives the «проверка…» indicator and the **edit-lock**, independent of `status`. |
| **Incomplete** | A catalog default or binding with an unfilled required var (`missingRequiredVars` non-empty). Never probed or spawned; UI shows «требует настройки». |
| **«требует настройки»** | Catalog server state: a required **catalog**-level var has no value — the author must fill it in the catalog. Refresh is disabled until filled (`incomplete` / `missingVars`). |
| **«шаблон» / templateOnly** | Catalog server state: the server has a required **per-project hole**, so its default config can never be probed at the catalog level (the reactor skips it); usable only once **bound** to a project that supplies the value. The `templateOnly` flag on **McpRegistryServer**. |
| **enabled flag** | Catalog-level on/off. A disabled server is excluded from probes and every project **overlay**, but its **bindings** are kept (re-enable restores them). Project rows show it grayed, «отключён в каталоге». |
| **Runtime snapshot** | `McpRuntimeSnapshot` (per project↔server) / `McpCatalogRuntimeSnapshot` (per catalog server) — the flattened, streamed view of registry state. |
| **Overlay** | The per-project qwen settings file (`<mcpOverlayDir>/<projectId>/system.json`) that is the **single source** of MCP servers qwen sees. Written at turn-start. |
| **overlayFingerprint** | A policy-based hash of the project's enabled overlay. A change triggers a session **re-spawn** on the next turn. Subsumes the allow-list. |
| **Allow-list** | `--allowed-mcp-server-names` — the qwen CLI arg restricting which overlay servers are active. Derived from the overlay's enabled set. |
| **Turn-start gate** | `ProviderCommandReactor`'s reuse-vs-respawn decision; `overlayChanged` is one of its triggers. |
| **Kill-switch** | `MCP_ENGINE_USE_OVERLAY` (default true) — when false, the entire qwen↔MCP coupling is off and spawns match upstream. |
| **Tool policy** | `{ defaultDecision: allow|deny, exceptions[] }` — *intent*, intersected with discovered tools by qwen (and by `effectiveAllowedTools`). |
| **Warn-on-impact** | The confirmation modal shown before a catalog edit that would disrupt projects already using the server (removed per-project var / new required var). |
| **websiteUrl / docsUrl** | A server's docs link: `websiteUrl` is shipped on a **built-in** or back-filled from the **probe** (only-if-empty, shipped value wins; display-only, never user-edited). Surfaced to the UI as `docsUrl` («Документация»). |
| **serverDescription / serverWebsiteUrl** | Fields the **probe** captures from `client.getServerVersion()` (serverInfo), stored on the **probe record** and back-filled (only-if-empty) onto the catalog's `description` / `websiteUrl`. |
| **McpServerItemCard** | The unified item card — one shell shared by the catalog list, the project list, and the catalog detail header. Status dot + transport badge + **source tag** + name/status + a **McpItemActions** cluster. |
| **McpItemActions** | The shared right-side control cluster (one fixed order: refresh → edit → delete → enable/disable switch → collapse arrow) used by every **McpServerItemCard** surface. |
| **Source tag** | The `source` badge on an item card: «встроенный» for a **built-in**, «мой» for a custom (manual) server. |
