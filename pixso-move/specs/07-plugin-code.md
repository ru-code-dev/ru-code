# Task 7 — Plugin sandbox (`code.ts`)

The sandbox side: read the selection, **validate it's one frame**, serialize the node subtree,
export a 1× preview, and bridge to the UI over `postMessage`. Pure helpers are unit-tested.

## File budget (all authored ≤150 LOC, single-responsibility)
| Path | Responsibility | LOC | tested |
|---|---|---|---|
| `src/code/code.ts` | entry: `showUI`, selection listener, message routing (glue) | ~70 | no (needs Pixso) |
| `src/code/selection.ts` | `validateSelection` — pure | ~25 | yes |
| `src/code/serialize.ts` | `serializeNode` — recursive collect | ~95 | yes |
| `src/code/nodeProps.ts` | per-node property extraction (split out of serialize) | ~60 | yes |
| `src/code/base64.ts` | `bytesToBase64` — pure encoder | ~25 | yes |
| `src/code/settings.ts` | `clientStorage` read/save + `parseSettings` (pure) | ~40 | pure part yes |
| `src/shared/messages.ts` | typed UI↔code message unions (shared with UI) | ~35 | n/a |
| `tests/*` | one per pure module | — | — |

> If `serialize.ts` would exceed 150 LOC, the per-node property extraction lives in `nodeProps.ts`
> and `serialize.ts` only does the recursion + caps. `messages.ts` lives under `src/shared/` so both
> the sandbox and the iframe import the same unions (DRY).

## Plugin lifecycle (`code.ts`)
```ts
pixso.showUI(__html__, { width: 380, height: 560 });
pixso.on("selectionchange", () => postSelectionState());
pixso.ui.onmessage = (msg: UiToCode) => { /* route: "request-preview" | "collect-and-send-meta" */ };
```
- On load and on every `selectionchange`, compute `validateSelection(pixso.currentPage.selection)`
  and post the result to the UI (so the UI can enable/disable Send and show the "not allowed"
  message live).

## Selection validation (`selection.ts`) — PURE, the core rule
> Rule: support a **regular selection of exactly one node** (its whole subtree comes with it).
> Reject ctrl/shift multi-select of unrelated items.

```ts
type SelectionVerdict =
  | { ok: true; node: { id: string; name: string } }
  | { ok: false; reason: "empty" | "multiple" };

export const validateSelection = (selection: ReadonlyArray<SceneNodeLike>): SelectionVerdict;
```
- `selection.length === 0` → `{ ok:false, reason:"empty" }` (UI: "Select a frame to analyze").
- `selection.length > 1` → `{ ok:false, reason:"multiple" }` (UI: "Select a single frame — multiple
  unrelated items aren't supported").
- `selection.length === 1` → `{ ok:true, node:{ id, name } }`. The one node's children come for
  free via serialization; no further parent/page checks needed because a single selected node is by
  definition one subtree.

`SceneNodeLike` is a minimal structural type (`{ id: string; name: string; type: string; … }`) so
the function is testable without the Pixso runtime.

## Node serialization (`serialize.ts`)
```ts
export const serializeNode = (node: SceneNodeLike): string;   // returns JSON string
```
- Recursively walk `node` + `node.children`, capturing a useful, **stable** subset of properties
  (id, name, type, geometry, layout/auto-layout, fills/strokes/effects, text + style,
  componentId/variant info). Borrow the property list from the reference's `nodes-full` collector
  (`packages/pixso-plugin/.../nodes-full.ts`) as a **starting point** — it's a utility we can adapt.
- Guard depth/size: cap recursion depth and total node count (configurable consts) to avoid
  pathological trees; if capped, include a `truncated: true` marker. Log nothing here (sandbox has
  no server logger); surface a count to the UI.
- Output is `JSON.stringify` of the collected tree → becomes `IngestRequest.nodesJson`.
- Tested with hand-built fake node trees: nested children serialized; selected subset of props
  present; depth/count cap triggers `truncated`; empty children handled.

## Preview export (1×) — in `code.ts` (not pure; thin)
```ts
const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
const base64 = bytesToBase64(bytes);   // bytesToBase64 is PURE + tested
```
- `bytesToBase64(Uint8Array): string` is a pure helper (chunked `String.fromCharCode` + `btoa`, or
  a manual base64 encoder since the sandbox may lack `btoa` — verify; provide a pure encoder and
  test it against known vectors).
- 1× scale per the product decision ("so we can use it later in pixel-perfect").
- The base64 (no `data:` prefix) → `IngestRequest.preview`.

## Message bridge (`messages.ts`) — typed both directions
```ts
type CodeToUi =
  | { type: "selection-state"; verdict: SelectionVerdict }
  | { type: "preview-ready"; preview: string; rootName: string }    // base64
  | { type: "collected"; nodesJson: string; rootName: string; preview: string; nodeCount: number }
  | { type: "error"; message: string };
type UiToCode =
  | { type: "request-preview" }                 // user selected → show preview in UI
  | { type: "collect-and-send-meta" };          // user pressed Send → gather everything for the UI to POST
```
- The **UI** owns the `fetch` to the server (it has the saved settings + designerId in
  `clientStorage` is read on the code side? — see note). Decision: **settings live UI-side** (the
  UI renders/edits them and does the POST); the **code side** only produces nodesJson + preview and
  hands them to the UI via `postMessage`. This keeps network out of the sandbox and matches the
  reference (UI did the fetch).
- On `collect-and-send-meta`: validate selection again (guard), serialize, export preview, post
  `{ type:"collected", nodesJson, rootName, preview, nodeCount }`. On any thrown error, post
  `{ type:"error", message }` (UI shows it) — the sandbox never throws unhandled.

> **clientStorage note:** Pixso `figma.clientStorage` is available in the **sandbox**, not the
> iframe. Two options: (a) UI sends settings to code to persist, code echoes them back on load; or
> (b) UI persists via a `clientStorage` round-trip through messages. Spec choice: the **code side**
> owns `clientStorage` (it's the only side with access); on load it reads settings and posts
> `{ type:"settings-loaded", settings }` to the UI; the UI sends `{ type:"save-settings", settings }`
> which code persists. Add these two message variants. (This is the one place the sandbox touches
> persistence; keep it tiny and tested via a fake clientStorage.)

## TDD — tests first
Pure helpers are fully tested (this is the plugin's tested surface):
- `validateSelection`: empty / single / multiple → correct verdicts.
- `serializeNode`: structure, prop subset, depth/count cap + `truncated`, empty children.
- `bytesToBase64`: known byte→base64 vectors; empty input.
- (if code-side settings) a `parseSettings`/`applyDefaults` pure helper for stored settings →
  tested for missing/partial/garbage stored values.

The thin glue in `code.ts` (showUI, exportAsync, message routing) is not unit-tested (needs the
Pixso runtime) — kept minimal; validated manually in task 9.

## Acceptance
- [ ] Selecting one frame → `{ ok:true }`; zero or multiple → the right rejection reason.
- [ ] Serialization produces stable JSON of the subtree with caps.
- [ ] 1× preview exported as base64.
- [ ] Sandbox never throws unhandled; errors are posted to the UI.
- [ ] Pure helpers tested; `typecheck`/oxlint clean.
