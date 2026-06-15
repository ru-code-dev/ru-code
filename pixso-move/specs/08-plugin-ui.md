# Task 8 — Plugin UI (iframe React app)

The designer-facing UI, built from the vendored ru-fork kit (task 6) and bridged to the sandbox
(task 7). Three screens: **Settings**, **Select/Preview**, **Send**. The UI owns settings state and
the `fetch` to the server.

## File budget (all authored ≤150 LOC, single-responsibility)
| Path | Responsibility | LOC | tested |
|---|---|---|---|
| `src/ui/App.tsx` | wire `reducer` + `useBridge` + switch screen (thin) | ~70 | manual |
| `src/ui/state/reducer.ts` | `reduce(state, msg)` — **pure** state machine | ~70 | yes |
| `src/ui/state/types.ts` | `Settings`, `UiState`, `Screen` types | ~25 | n/a |
| `src/ui/bridge.ts` | `postToCode` + `useBridge(dispatch)` hook (Pixso envelope) | ~40 | hook glue |
| `src/ui/api.ts` | `buildIngestRequest` (pure) + `sendToServer(_, _, fetchImpl)` | ~45 | yes |
| `src/ui/key.ts` | `generateDesignerId()` (`dz_${uuid}`) — pure | ~10 | yes |
| `src/ui/screens/SettingsScreen.tsx` | settings form (vendored Card/Field/Input/Button) | ~95 | manual |
| `src/ui/screens/SelectScreen.tsx` | placeholder + preview + Send | ~95 | manual |
| `src/ui/components/ui/*`, `lib/utils.ts` | **vendored** (task 6) | exempt |

> `App.tsx` stays thin: it holds `useReducer(reduce, initial)`, calls `useBridge(dispatch)`, and
> renders a screen by `state.screen`. **All UI logic is in the pure `reduce` + `api` + `key`
> modules** (100% unit-tested), so no screen file needs logic beyond rendering + dispatch.

## State model (local React state; no store needed)
```ts
type Settings = { serverUrl: string; designerId: string };
type Screen = "select" | "settings";
// plus: selectionVerdict, preview (base64|null), rootName, isSending, sendResult, errorMessage
```
- Settings come from the sandbox on load (`settings-loaded` message) and are saved back via
  `save-settings`. The UI never persists directly (sandbox owns `clientStorage`).

## Screen 1 — Settings (`SettingsScreen`)
Built with vendored `Card`, `Field`/`FieldLabel`/`FieldDescription`, `Input`, `Button`, `Label`.
- **Server URL** field — `Input`, default `http://localhost:7787`. Basic validation (non-empty,
  parses as URL) shown via `FieldError`.
- **Designer key (`designerId`)** field — `Input` showing the current key + two buttons:
  - **Generate** → `dz_${uuid}` (a `generateDesignerId()` pure helper; uuid via `crypto.randomUUID`
    in the iframe — DOM context, available). Fills the field.
  - **Save** → posts `save-settings` to the sandbox; shows a saved confirmation.
  - Copy-to-clipboard affordance (designer "writes it on paper"/shares it).
- Reachable via a gear button in the header from the Select screen, and on first run (no saved key)
  the UI opens Settings by default.

## Screen 2 — Select / Preview / Send (`SelectScreen`)
Driven by `selection-state` messages from the sandbox:
- **No/var selection** → placeholder card: "Select a frame to analyze" (verdict `empty`) or
  "Select a single frame — multiple unrelated items aren't supported" (verdict `multiple`).
  Send disabled.
- **Valid single selection** → request a preview (`request-preview` → `preview-ready`), show the
  **preview image** (the base64 PNG) in a `Card`, the frame name, and an enabled **Send to server**
  `Button`.
- **Send** flow:
  1. Guard: settings present (else route to Settings with a hint).
  2. Ask the sandbox to collect (`collect-and-send-meta` → `collected { nodesJson, rootName,
     preview, nodeCount }`).
  3. `api.sendToServer(settings, { designerId, rootName, nodesJson, preview })` → `POST {serverUrl}/ingest`
     with header `x-designer-id: <designerId>` and `IngestRequest` body.
  4. On 200 → success state (show returned `nodeId`); on non-2xx or network error → `errorMessage`
     from the response/`catch` (the UI surfaces server errors verbatim).

## api.ts (testable)
```ts
export const buildIngestRequest = (s: Settings, p: Collected): { url; headers; body }; // PURE
export const sendToServer = (s: Settings, p: Collected, fetchImpl = fetch): Promise<SendResult>;
```
- `buildIngestRequest` is pure (URL join, headers incl. `x-designer-id`, JSON body matching
  `IngestRequest`) → unit-tested.
- `sendToServer` takes an injectable `fetchImpl` → unit-tested with a fake fetch for 200 / 400 /
  413 / network-throw, asserting it maps to `SendResult`.

## Bridge (`bridge.ts`)
Thin `postToCode(msg: UiToCode)` and a `useBridge(dispatch)` hook wrapping `window.onmessage` →
`event.data.pluginMessage` (Pixso/Figma envelope), typed by the shared `src/shared/messages.ts`
unions (same file the sandbox imports). The hook only forwards incoming messages to `dispatch`; the
pure `reduce(state, msg)` (in `state/reducer.ts`) turns them into state — and is unit-tested.

## Look & feel
- Identical to ru-fork: same tokens (`bg-card`, `text-foreground`, `border-border`, `rounded-2xl`,
  button variants). Use `variant="default"` for primary Send, `variant="outline"`/`"ghost"` for
  secondary, `Alert` (if vendored) or `FieldError` for errors.
- Compact, plugin-sized (≈380×560). Header with title + gear (settings) button.

## TDD / validation
Plugin UI is exempt from the 100% gate, but the **pure** units are tested (vitest + jsdom or pure):
- `buildIngestRequest` → correct url/headers/body for given settings+payload.
- `sendToServer` → 200/4xx/throw mapped to `SendResult` via fake fetch.
- `generateDesignerId` → `dz_` prefix + uuid shape.
- `reduce(state, msg)` → each `CodeToUi` message produces the right state transition
  (selection-state enables/disables Send; preview-ready sets the image; error sets errorMessage;
  collected triggers send; settings-loaded fills settings).
- React rendering is validated manually in task 9 (Pixso). Optionally add React Testing Library
  smoke tests for the two screens if jsdom is wired — not required for the gate.

`typecheck` + `oxlint` must be clean.

## Acceptance
- [ ] Settings screen sets/generates/saves server URL + designerId; persisted via sandbox.
- [ ] Placeholder + the exact "not allowed" copy for multi-select; Send disabled when invalid.
- [ ] Valid selection shows the 1× preview + enabled Send.
- [ ] Send POSTs the correct `IngestRequest` with `x-designer-id`; success shows `nodeId`, errors
      surfaced verbatim.
- [ ] Looks identical to ru-fork; pure logic tested; `typecheck`/oxlint clean.
