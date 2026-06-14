# MCP — Improvements Branch 2 (var-model edge cases + UI consistency)

> Follow-up to branch-1 + the unified-card/var-model refactor. P1/P2/P3/P5 are web-only; **P4 spans the
> contract + server + web** (the `valueLocked` bit — see below). **No SQL migration** (vars live in
> `vars_json`; the new field is an Effect-schema `optionalKey`, so old rows decode and existing built-ins
> re-sync on next startup via the `builtinHash` change).

## Context (gates off, per user)

The unified-card refactor, the var-model change, and the `atlassian` built-in are in the working tree
un-gated. The user has chosen **not to run gates** for this branch — proceed straight to the edits below.
(For reference only, the env baseline is the 4 `tests/bin.test.ts` failures — qwen/cli.js absent.)

## Decisions captured (LOCKED — no open questions)

- **P5 — catalog DETAIL dot stays as-is.** Do **not** color the dot. Only **add the «Требует настройки» status
  text** under the description. (User: "leave the dot! only add status.")
- **P3 — color = «требует настройки» amber, not red.** Unfilled required CATALOG vars in the read-only vars
  block are marked **amber** (`text-amber-700 dark:text-amber-300/90`) + an amber `*`, matching the status
  word — NOT the project dialog's hard-red border. A per-project hole empty at the catalog is normal ⇒ not
  marked.
- **P6 — `field-sizing` is for the locked NAME ONLY.** The value field stays full-width (`flex-1`) — a long
  read-only URL with `field-sizing:content` grows past the row and adds horizontal scroll (user-reported).
  Latest-Chrome web target. Because `<Input>`'s `className` lands on the **wrapper span** and the inner
  `<input>` is hardcoded `w-full`, the working form is the descendant pair
  **`[&_input]:[field-sizing:content] [&_input]:w-auto`** on a `w-auto max-w-full` wrapper. Editable name rows
  keep `w-2/5`.
- **P3 second half — the EDIT MODAL marks empty required catalog values RED.** `ConfigSummary` (read-only) is
  amber; `VarsEditor`'s value `<Input>` gets `aria-invalid` (red border) when an empty required catalog var
  must be filled (`!perProject && required && value==="" && !(secret && hasStoredSecret)`), exactly like
  `ProjectConfigDialog` marks unfilled per-project holes. (Missed in the first pass.)
- **P4 — read-only value needs a STABLE BIT, not a value-derived guess (CORRECTED).** The first attempt
  (`valueReadonly = declarationLocked && value.length > 0`) was broken: it locked a user-fillable var the
  instant a letter was typed, and again after save. "Author-fixed" is a property of the built-in *definition*
  (shipped value non-null), not the live value, so it's a per-var bit `valueLocked`, sourced server-side and
  surfaced to the UI. No SQL migration — vars live in `vars_json`; the bit is a new `McpServerVar` schema
  field modeled like `keepSecret` (`Schema.optionalKey(Schema.Boolean)`, narrowly-true), NOT like the always-
  meaningful `origin`. Also fixes `buildSyncedBuiltin` so a locked value re-adopts the shipped value on
  re-sync (a deployer URL change propagates), while holes keep the user's value.
- **P2 — wording LOCKED: «Требует настройки в каталоге», grayed (neutral/disabled dot + muted text), card
  dimmed, recheck disabled.** It points the user to «Показать в каталоге» (already in the collapse body).
- **P1 — «требует настройки» count badge + tooltip** on the catalog list (names overflow one line); the
  catalog **detail** (P5) has room and lists the names inline.

---

## Edit manifest

**Web (UI):**

| # | File | Items | New imports |
|---|---|---|---|
| 1 | `components/McpServerItemCard.tsx` | P1 | — (`ReactNode` already imported) |
| 2 | `components/RegistryTab.tsx` | P1 | `type ReactNode` (react), `Badge` |
| 3 | `components/RegistryDetail.tsx` | P5 | — |
| 4 | `components/ConfigSummary.tsx` | P3 | — (`Badge` already imported) |
| 5 | `components/VarsEditor.tsx` | P3·P4·P6 | `LockIcon` (lucide-react), `cn` |
| 6 | `components/ProjectBindingRow.tsx` | P2 | — |
| 7 | `mcp-manage/types.ts` | P4 | — (`McpVar` += `valueLocked`) |
| 8 | `mcp-manage/adapters.ts` | P4 | — (`catalogVarToUi` surfaces `valueLocked`) |
| 9 | `components/addMcpParsing.ts` | P4 | — (pasted env vars: `valueLocked: false`) |

**Contract + server (P4's `valueLocked` bit):**

| # | File | Change |
|---|---|---|
| 10 | `contracts/src/ru-fork/mcp.ts` | `McpServerVar` += `valueLocked: Schema.optionalKey(Schema.Boolean)` |
| 11 | `server/.../mcp/McpBuiltins.ts` | `builtinShippedVars` sets `valueLocked: variable.value !== null` |
| 12 | `server/.../mcp/McpCatalogBuilders.ts` | `buildSyncedBuiltin` `keptValue`: locked value re-adopts shipped value |

`McpSecrets.ts` (`splitServerVars`) is **unchanged** — user/custom vars omit `valueLocked` (optionalKey), and a
locked template re-stamps it from `...shipped` in `mergeTemplateVars`. Server test fixtures are **unchanged**
(optionalKey ⇒ literals may omit it). No SQL migration (`vars_json`).

---

## P1 — catalog list: «требует настройки» count badge + tooltip

`McpServerItemCard` line-2 is a single `truncate` `<p>`; `server.missingVars.join(", ")` overflows. Show
«требует настройки» + a small count badge whose `title` lists the names; drop the inline names.

### Edit 1a — `McpServerItemCard.tsx`: add optional `statusBadge` prop

**Interface — before:**
```tsx
  readonly statusLabel?: McpItemStatusLabel | undefined;
  readonly statusDetail?: string | undefined;
```
**after:**
```tsx
  readonly statusLabel?: McpItemStatusLabel | undefined;
  readonly statusDetail?: string | undefined;
  /** Optional small chip after the status word (e.g. a count for «требует настройки»). */
  readonly statusBadge?: ReactNode | undefined;
```

**Destructure — before:** `  statusLabel,\n  statusDetail,` → **after:** add `  statusBadge,` between them
(i.e. `statusLabel, statusBadge, statusDetail,`).

**Line-2 render — before:**
```tsx
            {(statusLabel || statusDetail) && (
              <p className="truncate text-xs">
                {statusLabel && <span className={statusLabel.className}>{statusLabel.text}</span>}
                {statusLabel && statusDetail && <span className="text-muted-foreground"> · </span>}
                {statusDetail && <span className="text-muted-foreground">{statusDetail}</span>}
              </p>
            )}
```
**after:**
```tsx
            {(statusLabel || statusDetail || statusBadge) && (
              <p className="truncate text-xs">
                {statusLabel && <span className={statusLabel.className}>{statusLabel.text}</span>}
                {statusBadge && <span className="ml-1 align-middle">{statusBadge}</span>}
                {statusLabel && statusDetail && <span className="text-muted-foreground"> · </span>}
                {statusDetail && <span className="text-muted-foreground">{statusDetail}</span>}
              </p>
            )}
```
`ReactNode` is already imported (`import type { ReactNode } from "react";`).

### Edit 1b — `RegistryTab.tsx`: emit the badge in the `incomplete` branch

**Imports — before:** `import { useMemo, useState } from "react";` →
**after:** `import { type ReactNode, useMemo, useState } from "react";`
Add `import { Badge } from "~/components/ui/badge";` **between** the `~/components/ui/alert-dialog` block
(ends `} from "~/components/ui/alert-dialog";`) and `import { Button } from "~/components/ui/button";`
(alphabetical: badge < button).

**Declarations — before:**
```tsx
              let statusLabel: McpItemStatusLabel | undefined;
              let statusDetail: string;
```
**after:**
```tsx
              let statusLabel: McpItemStatusLabel | undefined;
              let statusDetail: string;
              let statusBadge: ReactNode | undefined;
```

**`incomplete` branch — before:**
```tsx
              if (server.incomplete) {
                // Catalog-level required vars are unfilled — fixable HERE (edit the server). Name them.
                statusLabel = {
                  text: "требует настройки",
                  className: "text-amber-700 dark:text-amber-300/90",
                };
                statusDetail = server.missingVars.join(", ");
              } else if (server.templateOnly) {
```
**after:**
```tsx
              if (server.incomplete) {
                // Catalog-level required vars are unfilled — fixable HERE (edit the server). The names
                // overflow the truncated line, so show a count badge; the tooltip lists them in full.
                statusLabel = {
                  text: "требует настройки",
                  className: "text-amber-700 dark:text-amber-300/90",
                };
                statusDetail = "";
                statusBadge = (
                  <Badge variant="warning" size="sm" title={server.missingVars.join(", ")}>
                    {server.missingVars.length}
                  </Badge>
                );
              } else if (server.templateOnly) {
```
(`statusDetail = ""` → falsy → the `{statusDetail && …}` span renders nothing. The other two branches leave
`statusBadge` undefined.)

**Card props — before:** `                  statusDetail={statusDetail}` →
**after:**
```tsx
                  statusDetail={statusDetail}
                  statusBadge={statusBadge}
```

`Badge` forwards `title`/`size`/`variant` (it spreads `...props` via `mergeProps`); `variant="warning"` is
amber-toned (`bg-warning/8 text-warning-foreground`), `size="sm"` is the smallest chip.

**Verify:** the `atlassian` built-in (4 unfilled vars) shows «требует настройки» + a `4` chip; hovering lists
`JIRA_USERNAME, JIRA_API_TOKEN, CONFLUENCE_USERNAME, CONFLUENCE_API_TOKEN`.

---

## P2 — project row: catalog-incomplete server shows «Подключение» (model gap)

**Root cause (verified):** `computeMissingVars` (`adapters.ts`) filters on `variable.perProject`, so
`binding.incomplete` ignores **catalog-level** required vars. The reactor's `missingRequiredVars` counts ALL
required vars → skips probing → no runtime → `runtimeStatusToUi(enabled, undefined, …)` → `"connecting"`
(blue «Подключение»), stuck. The data we need is already on the row: `server.incomplete` /
`server.missingVars`. Fix is row-level display only (mirrors the existing `catalogDisabled` override).

### Edit 2a — `ProjectBindingRow.tsx`: derive `catalogIncomplete`, re-order the status block

**before:**
```tsx
  // ⑬ the catalog server is disabled — the binding stays listed but grayed + inactive.
  const catalogDisabled = !server.enabled;
  // The dot/status the row should show: neutral «disabled» when the catalog server is off.
  const rowStatus = catalogDisabled ? "disabled" : binding.status;
  const statusVis = statusVisual(binding.status);
  // Line 2 leading word: disabled-in-catalog / requires-setup / the live status; counts after.
  const statusLabel = catalogDisabled
    ? { text: "Отключён в каталоге", className: statusVisual("disabled").textClass }
    : binding.incomplete
      ? {
          text: `Требует настройки: ${binding.missingVars.join(", ")}`,
          className: "text-amber-700 dark:text-amber-300/90",
        }
      : { text: statusVis.label, className: statusVis.textClass };
  const statusDetail =
    catalogDisabled || binding.incomplete ? undefined : toolsCountLabel(tools.length);
  const errorMessage =
    !catalogDisabled && !binding.incomplete && binding.status === "error"
      ? binding.health.detail
      : undefined;
```
**after:**
```tsx
  // ⑬ the catalog server is disabled — the binding stays listed but grayed + inactive.
  const catalogDisabled = !server.enabled;
  // P2: the catalog server has unfilled CATALOG-level required vars (server.incomplete). The reactor
  // skips probing it, so this binding has no runtime row and would read «Подключение» (blue) forever.
  // It's the catalog author's job to fix (the project can't), so show a neutral, catalog-pointing state.
  const catalogIncomplete = !catalogDisabled && server.incomplete;
  // The dot/status the row should show: neutral when the catalog server is off OR needs catalog setup.
  const rowStatus = catalogDisabled || catalogIncomplete ? "disabled" : binding.status;
  const statusVis = statusVisual(binding.status);
  // Line 2 leading word, by priority: off-in-catalog → needs-catalog-setup → per-project setup → status.
  const statusLabel = catalogDisabled
    ? { text: "Отключён в каталоге", className: statusVisual("disabled").textClass }
    : catalogIncomplete
      ? { text: "Требует настройки в каталоге", className: statusVisual("disabled").textClass }
      : binding.incomplete
        ? {
            text: `Требует настройки: ${binding.missingVars.join(", ")}`,
            className: "text-amber-700 dark:text-amber-300/90",
          }
        : { text: statusVis.label, className: statusVis.textClass };
  const statusDetail =
    catalogDisabled || catalogIncomplete || binding.incomplete
      ? undefined
      : toolsCountLabel(tools.length);
  const errorMessage =
    !catalogDisabled && !catalogIncomplete && !binding.incomplete && binding.status === "error"
      ? binding.health.detail
      : undefined;
```

### Edit 2b — context-menu recheck disabled

**before:** `          { id: "recheck", label: "Проверить", disabled: binding.incomplete },`
**after:** `          { id: "recheck", label: "Проверить", disabled: binding.incomplete || catalogIncomplete },`

### Edit 2c — card `dimmed`

**before:** `      dimmed={catalogDisabled}`
**after:** `      dimmed={catalogDisabled || catalogIncomplete}`
(`description={!catalogDisabled ? …}` stays — the description still shows; only the catalog-off case hides it.)

### Edit 2d — actions recheck disabled

**before:** `          recheckDisabled={binding.incomplete}`
**after:** `          recheckDisabled={binding.incomplete || catalogIncomplete}`

**Verify:** bind a server, empty one of its **catalog-level** required vars → the project row goes grayed
«Требует настройки в каталоге» (neutral dot, dimmed, refresh disabled), NOT blue «Подключение»; refill it in
the catalog → the row returns to its real status.

---

## P3 — catalog detail vars block: mark unfilled required catalog vars (amber)

`ConfigSummary` → `VarsBlock` shows var names in plain `text-foreground`. Mark an unfilled CATALOG-level
required var amber + amber `*`.

### Edit 3 — `ConfigSummary.tsx`: `VarsBlock`

**before:**
```tsx
function VarsBlock({ vars }: { vars: readonly McpVar[] }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted-foreground">vars</span>
      <div className="min-w-0 space-y-0.5">
        {vars.map((variable) => (
          <div key={variable.name} className="flex flex-wrap items-center gap-1.5 break-all">
            <span className="text-foreground">{variable.name}</span>
            {variable.secret && (
              <Badge variant="outline" className="px-1 py-0 text-[10px]">
                секрет
              </Badge>
            )}
            {variable.perProject && (
              <Badge variant="outline" className="px-1 py-0 text-[10px]">
                проект{variable.required ? " *" : ""}
              </Badge>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```
**after:**
```tsx
function VarsBlock({ vars }: { vars: readonly McpVar[] }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted-foreground">vars</span>
      <div className="min-w-0 space-y-0.5">
        {vars.map((variable) => {
          // Unfilled CATALOG-level required var ⇒ «требует настройки» (amber). A per-project hole being
          // empty at the catalog is normal (it's filled per project) ⇒ not marked.
          const needsCatalogValue =
            !variable.perProject && variable.required && variable.value.length === 0;
          return (
            <div key={variable.name} className="flex flex-wrap items-center gap-1.5 break-all">
              <span
                className={
                  needsCatalogValue ? "text-amber-700 dark:text-amber-300/90" : "text-foreground"
                }
              >
                {variable.name}
                {needsCatalogValue && <span className="ml-0.5">*</span>}
              </span>
              {variable.secret && (
                <Badge variant="outline" className="px-1 py-0 text-[10px]">
                  секрет
                </Badge>
              )}
              {variable.perProject && (
                <Badge variant="outline" className="px-1 py-0 text-[10px]">
                  проект{variable.required ? " *" : ""}
                </Badge>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

**Verify:** open the `atlassian` detail → `JIRA_USERNAME`, `JIRA_API_TOKEN`, `CONFLUENCE_USERNAME`,
`CONFLUENCE_API_TOKEN` names are amber with `*`; `JIRA_URL`/`CONFLUENCE_URL` (have values) stay normal.

---

## P5 — catalog DETAIL header: add «Требует настройки» status text (dot unchanged)

`RegistryDetail` only renders a red line for `status === "error" && message`; an `incomplete` server shows
nothing. Add an amber line under the description. **Dot is NOT changed** (user decision).

### Edit 5 — `RegistryDetail.tsx`: after the error line

**before:**
```tsx
        {/* ⑫ surface the probe failure text, not just the dot */}
        {server.status === "error" && server.message && (
          <p className="mt-1 pl-4 text-xs leading-snug text-red-600 dark:text-red-300/90">
            {server.message}
          </p>
        )}
        <div className="mt-3">
```
**after:**
```tsx
        {/* ⑫ surface the probe failure text, not just the dot */}
        {server.status === "error" && server.message && (
          <p className="mt-1 pl-4 text-xs leading-snug text-red-600 dark:text-red-300/90">
            {server.message}
          </p>
        )}
        {/* P5: catalog-level required vars unfilled — fixable HERE (edit the server). Dot unchanged;
            the detail has room, so list the names inline (the list view uses a count badge instead). */}
        {server.incomplete && (
          <p className="mt-1 pl-4 text-xs leading-snug text-amber-700 dark:text-amber-300/90">
            Требует настройки: {server.missingVars.join(", ")}
          </p>
        )}
        <div className="mt-3">
```

**Verify:** open the `atlassian` detail → «Требует настройки: JIRA_USERNAME, …» appears under the description;
the status dot is unchanged.

---

## P4 + P6 — edit modal vars: `valueLocked` read-only + locked NAME fits content (AS BUILT)

Two distinct things, both in the edit modal (`VarsEditor`), plus the contract/server bit that backs P4.

### The `valueLocked` bit (contract + server)

`McpServerVar` gains `valueLocked: Schema.optionalKey(Schema.Boolean)` — set true by `builtinShippedVars`
when the definition's value is non-null (the author's fixed URL), false/absent for holes. It rides through
`mergeTemplateVars` (`{ ...shipped, value }`) on user edits and `buildSyncedBuiltin` (`{ ...variable, … }`)
on re-sync, so it is **stable across typing and saving** — the live value never drives it. `buildSyncedBuiltin`
also now lets a locked value re-adopt the **shipped** value (a deployer URL change propagates), while a hole
keeps the user's value:
```ts
const keptValue =
  variable.valueLocked || prior === undefined || prior.value === null ? variable.value : prior.value;
```
`adapters.catalogVarToUi` surfaces it as `valueLocked: variable.valueLocked === true`; UI `McpVar` carries
`readonly valueLocked: boolean` (also set `false` in `EMPTY_VAR` + `addMcpParsing`).

### P4 — value read-only when `valueLocked`

```tsx
// NOT derived from the live value (that locked a field mid-type and after save) — a stable definition bit.
const valueReadonly = declarationLocked && variable.valueLocked;
```
The value `<Input>` is `disabled={variable.perProject || valueReadonly}` and shows a «задано шаблоном»
`LockIcon` hint when `valueReadonly`. So `JIRA_URL` (shipped value) is read-only; `JIRA_USERNAME`/tokens
(shipped `null`) stay editable through typing and across saves.

### P3 second half — empty required catalog value marked RED

```tsx
const catalogValueMissing =
  !variable.perProject && variable.required && variable.value.length === 0 &&
  !(variable.secret && variable.hasStoredSecret);
// on the value <Input>:
aria-invalid={catalogValueMissing || undefined}   // red border (omit when valid), like ProjectConfigDialog
```

### P6 — locked NAME fits content; value stays full-width

The **name** `<Input>` fits its content when locked (no scroll); the **value** `<Input>` stays full-width
(`flex-1`) — `field-sizing` on a long read-only URL would push the row into horizontal scroll. Because
`<Input>`'s `className` lands on the **wrapper span** (input.tsx) and the inner `<input>` is hardcoded
`w-full`, the name uses the descendant form `[&_input]:w-auto [&_input]:[field-sizing:content]` on a
`w-auto max-w-full` wrapper (wrapper-scoped `& input` specificity (0,1,1) beats `.w-full` (0,1,0)):
```tsx
className={cn(
  "font-mono",
  declarationLocked
    ? "w-auto max-w-full [&_input]:w-auto [&_input]:[field-sizing:content]"   // name only
    : "w-2/5",
)}
// value input: className="min-w-0 flex-1 font-mono"  (full width, NO field-sizing)
```
Imports added to `VarsEditor`: `LockIcon` (lucide-react), `cn` (`~/lib/utils`).

**Verify:** typing into `JIRA_USERNAME` keeps focus and stays editable (never «задано шаблоном»); after saving
it, reopening keeps it editable; `JIRA_URL` is read-only with the lock hint; empty required values
(`JIRA_USERNAME`, tokens) show a red border; the locked name `CONFLUENCE_API_TOKEN` is fully visible (no
scroll); the `…/wiki` value sits in a normal full-width box (no horizontal scroll). After a deployer changes
`JIRA_URL` in source, existing installs adopt the new URL on next startup; user-filled usernames are kept.

---

## Build-safety checklist (why this compiles as written)

- **Types:** `statusBadge?: ReactNode | undefined` (optional, `exactOptionalPropertyTypes`-safe); `ReactNode`
  imported in both card + RegistryTab; `statusBadge` declared `let … | undefined` so all branches are
  defined. `catalogIncomplete`/`valueReadonly`/`needsCatalogValue` are local `boolean`s.
- **No casts** (`as`/`any`/`unknown`); only string classNames + `cn()`.
- **Existing data only:** `server.incomplete`, `server.missingVars`, `McpVar.value` (always a `string`, `""`
  when null), `variable.origin`, `variable.required` — all already on the view-types; no `adapters`/contract
  edits.
- **Primitives:** `Badge` spreads `...props` ⇒ `title` works; `variant="warning"`/`size="sm"` exist.
  `cn` = `~/lib/utils`. Tailwind JIT emits arbitrary variant+property `[&_input]:[field-sizing:content]`.
- **No new files, no deleted exports, no signature changes** ⇒ no other consumer breaks (`statusBadge` is
  additive and optional).

## Features this branch delivers

1. Catalog list: «требует настройки» shows a **count chip + hover-tooltip** instead of an overflowing name list.
2. Project list: a binding whose **catalog** server has unfilled required vars reads a grayed **«Требует
   настройки в каталоге»** (neutral dot, dimmed, refresh off) instead of a stuck blue «Подключение».
3. Catalog detail vars block: unfilled required catalog vars are **amber-marked** (name + `*`), consistent
   with the status word.
4. Catalog detail header: adds a **«Требует настройки: …»** status line (dot unchanged).
5. Edit modal: locked var **names** and locked shipped **values** render as **content-fitting** read-only
   fields (no horizontal scroll), with a **«задано шаблоном»** lock hint; editable rows unchanged.

## Sequencing

P1 → P3 → P5 → P6/P4 (independent, mostly disjoint files) → P2 last (touches `ProjectBindingRow` only).
Nothing here touches the backend, schema, contracts, or the migration.

## Constraints (unchanged from branch-1)

- Web has no test target → validated by typecheck + lint only.
- No `as`/`any`/`unknown` casts; `Effect.catch` not `catchAll`; `logError`/`logDebug` only; mark ru-fork
  deltas with `ru-fork:`. qwen is never run here.
