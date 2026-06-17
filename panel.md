# Panel system refactor — implementation plan

Branch/worktree: `features-ui` (from `ru-code` @ `db5b9299`).
Status: **PLAN ONLY — no source edited.** This document is the contract to review before any edit.

---

## 1. Requirements

1. **Diff panel** stays exactly where it is — thread-scoped, URL-driven (`?diff=1`), only on an active thread. No behavioural change.
2. **MCP panel** moves to "where Pixso is now": a global overlay mounted at the app-layout level, opened from the **left sidebar**.
3. **Only one** of {diff, mcp, pixso} can be open at any time (full 3-way mutual exclusion).
4. **Pixso** and **MCP** both open from the **left sidebar** nav group.
5. Clicking the **same** left-nav item again **closes** the open panel (toggle).
6. DRY, clean, senior-level — no copy-pasted hosts, consistent imports.

---

## 2. Current architecture & problems

| Panel | Open-state | Trigger | Mount | Exclusion |
|---|---|---|---|---|
| Diff | URL `?diff=1` | header toggle + `diff.toggle` shortcut | `DiffPanelInlineSidebar` in thread route | closes MCP only |
| MCP | `useMcpManagerStore.panelOpen` | **header toggle** (not nav) | `McpPanelMount` in `_chat.tsx` | closes diff only |
| Pixso | `usePixsoStore.panelOpen` | left nav "Макеты Pixso" (open-only) | `AppSidebarLayout` | **none** |

Problems:

- **P1 — three open-state mechanisms, ad-hoc pairwise exclusion.** Pixso is ignored by both diff and MCP, so opening Pixso leaves diff/MCP open. No single source of truth.
- **P2 — three near-identical inline-sidebar hosts.** `PixsoPanelInlineSidebar` and `McpPanelInlineSidebar` are byte-identical except 4 constants + the panel; `DiffPanelInlineSidebar` only adds a `shouldAcceptWidth` guard.
- **P3 — duplicated responsive (sheet-vs-inline) selection** in `McpPanelMount` and (pre-refactor) `AppSidebarLayout`.
- **P4 — MCP nav item is inert** (placeholder), MCP is driven only from the chat header.

---

## 3. Target architecture (registry-driven, N-way out of the box)

```
┌─ ru-fork/rightPanel/registry.tsx ─────────────────────────────────────┐
│  OVERLAY_PANELS: readonly [{ id, label, icon, width, render }]  (module const)
│  type OverlayPanel = (typeof OVERLAY_PANELS)[number]["id"]   (derived)
│  → THE single place to add a panel: append one entry. id-union derives itself.
│  → imports panel COMPONENTS directly (not barrels) to avoid an import cycle.
└────────────────────────────────────────────────────────────────────────┘
┌─ ru-fork/rightPanel/store.ts ─────────────────────────────────────────┐
│  useRightPanelStore: { open: OverlayPanel | null, toggle, close }
│  → single source of truth; one enum ⇒ N-way mutual exclusion is automatic;
│    toggle ⇒ click-to-close. (imports OverlayPanel type from registry)
└────────────────────────────────────────────────────────────────────────┘
┌─ components/RightInlineSidebar.tsx ───────────────────────────────────┐
│  Pure presentational shell for ANY right inline sidebar.
│  Props: open, onOpenChange, storageKey, defaultWidth, min/maxWidth,
│         shouldAcceptWidth?, children.   Shared by diff + overlays.
└────────────────────────────────────────────────────────────────────────┘
┌─ ru-fork/rightPanel/OverlayPanelHost.tsx ─────────────────────────────┐
│  ONE shared host for ALL overlays: picks sheet vs RightInlineSidebar, renders
│  whichever entry is open. Keeps content mounted through the close slide; swaps
│  content in place when switching overlays; width/resize follow the active entry.
│  The single home of the sheet/inline logic; one gap ⇒ the main column animates once.
└────────────────────────────────────────────────────────────────────────┘
┌─ consumers (data-driven, no per-panel code) ──────────────────────────┐
│  PixsoNavGroup    → OVERLAY_PANELS.map(button)   (toggle + isActive)
│  AppSidebarLayout → <OverlayPanelHost />          (one shared slot)
└────────────────────────────────────────────────────────────────────────┘

Adding panel #N = ONE entry in OVERLAY_PANELS. The id-union, the nav button, the
mount, and N-way exclusion all follow automatically. No per-feature mount files.

Diff stays URL-driven and is NOT in the coordinator. It coordinates at TWO seams:
  • opening diff  → useRightPanelStore.close()   (close whichever overlay is open)
  • opening overlay → effect in thread route closes diff (overlay open ⇒ ?diff=undefined)
```

Why diff stays separate: it is thread-scoped and URL-addressable (deep-linkable, survives reload). Folding it into the store would lose that. The two seams give complete exclusion while keeping URL ownership local to the route that owns it.

**Why deep imports in the registry.** `registry.tsx` imports `McpPanel`/`PixsoPanel` from their **component files** (`~/ru-fork/<m>/components/<Panel>`), NOT the module barrels. Importing via a barrel would cycle: registry → `pixso-move/index` → `PixsoNavGroup` → registry. The panel components depend only on their own stores, so the deep import yields an acyclic graph: `store → registry → panel components`; `OverlayPanelMount → {store, registry}`; `nav/layout → registry`.

**Re-render safety.** `OVERLAY_PANELS` is a module constant, so every `render` fn has a stable identity (no per-render allocation, no `useCallback` needed). Each `OverlayPanelMount` subscribes via `useRightPanelStore((state) => state.open === panel.id)` → a boolean; zustand re-renders a mount only when *its* boolean flips, so toggling one panel re-renders just the two affected mounts, never all of them.

---

## 4. Import-style rules (measured from the codebase, must follow)

- **`apps/web/src/components/*.tsx`** → **relative**: `./ui/sidebar` (57 vs 10), sibling `./Name` (35 vs 0).
- **`apps/web/src/routes/*.tsx`** → **relative**: `../components/...` (25 vs 2), `../ru-fork/...`.
- **`apps/web/src/ru-fork/*/**`** → **`~/` alias** for cross-app (`~/components/ui/...`, `~/hooks/...`, `~/components/RightPanelSheet`, `~/rightPanelLayout`, `~/ru-fork/<other-module>`); **relative** for same-module (`./McpPanel`, `../store`).

---

## 5. NEW FILES (full content)

### 5.1 `apps/web/src/ru-fork/rightPanel/registry.tsx`

> The single place to add/remove/reorder overlay panels. Imports panel **components
> directly** (not barrels) to keep the dependency graph acyclic — see §3.

```tsx
import type { LucideIcon } from "lucide-react";
import { LayersIcon, ServerIcon } from "lucide-react";
import type { ReactNode } from "react";

import { McpPanel } from "~/ru-fork/mcp-manage/components/McpPanel";
import { PixsoPanel } from "~/ru-fork/pixso-move/components/PixsoPanel";

/**
 * The form a panel is rendered in: a wide-screen offcanvas sidebar or a narrow-screen
 * sheet. Values are a subset of `DiffPanelMode` so they pass straight through as a
 * panel's `mode` (no mapping). ("inline" — the legacy full-width diff — is unused here.)
 */
export type OverlayPanelForm = "sidebar" | "sheet";

export interface OverlayPanelWidth {
  readonly storageKey: string;
  readonly defaultWidth: string;
  readonly minWidth: number;
  readonly maxWidth: number;
}

export interface OverlayPanelEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly width: OverlayPanelWidth;
  readonly render: (form: OverlayPanelForm, onClose: () => void) => ReactNode;
}

/**
 * ru-fork: the registry of global right-side overlay panels. Adding a panel = one
 * entry here; the id-union, the left-nav button, the mount, and N-way mutual
 * exclusion all follow automatically. `as const satisfies` keeps each entry
 * type-checked while preserving the literal `id`s for the derived union below.
 */
export const OVERLAY_PANELS = [
  {
    id: "mcp",
    label: "MCP Серверы",
    icon: ServerIcon,
    width: {
      storageKey: "chat_mcp_sidebar_width",
      defaultWidth: "clamp(24rem,32vw,34rem)",
      minWidth: 22 * 16,
      maxWidth: 40 * 16,
    },
    render: (form: OverlayPanelForm, onClose: () => void) => (
      <McpPanel onClose={onClose} mode={form} />
    ),
  },
  {
    id: "pixso",
    label: "Макеты Pixso",
    icon: LayersIcon,
    width: {
      storageKey: "chat_pixso_sidebar_width",
      defaultWidth: "clamp(24rem,32vw,34rem)",
      minWidth: 22 * 16,
      maxWidth: 40 * 16,
    },
    render: (form: OverlayPanelForm, onClose: () => void) => (
      <PixsoPanel onClose={onClose} mode={form} />
    ),
  },
] as const satisfies readonly OverlayPanelEntry[];

/** Union of overlay-panel ids, derived from the registry — never hand-maintained. */
export type OverlayPanel = (typeof OVERLAY_PANELS)[number]["id"];
```

> Both entries pass `mode={form}` to their panel — each is built on `DiffPanelShell`, so
> the form (`"sidebar"` | `"sheet"`) drives the shared header/background geometry (px-4 row,
> Electron drag-region + WCO insets, bottom border) and the outline `Toggle` close button.
>
> **Widths:** MCP and Pixso intentionally share **identical** values (default
> `clamp(24rem,32vw,34rem)`, min 352px, max 640px) — exactly today's values; divergence is
> a one-line edit per entry. Each keeps its **own** `storageKey`, so a user's resize is
> remembered per panel. The **diff** panel is **not** in this registry — its width config
> stays in the thread route, **unchanged**.

### 5.2 `apps/web/src/ru-fork/rightPanel/store.ts`

```ts
/**
 * ru-fork: coordinator for the global right-side overlay panels (the registry in
 * ./registry). A single `open` enum makes them mutually exclusive for free, and
 * `toggle()` gives click-again-to-close.
 *
 * The diff panel stays URL-driven and thread-scoped (NOT modelled here); it
 * coordinates with this store at two thin seams in the thread route:
 *   - opening diff calls `close()` (closes whichever overlay is open);
 *   - an effect closes diff whenever an overlay opens.
 */

import { create } from "zustand";
import type { OverlayPanel } from "./registry";

interface RightPanelState {
  readonly open: OverlayPanel | null;
  readonly toggle: (panel: OverlayPanel) => void;
  readonly close: () => void;
}

export const useRightPanelStore = create<RightPanelState>()((set) => ({
  open: null,
  toggle: (panel) => set((state) => ({ open: state.open === panel ? null : panel })),
  close: () => set({ open: null }),
}));
```

> API is exactly `open` / `toggle` / `close` — the only verbs the call-sites use (nav →
> `toggle`, diff-open seam → `close`). No force-open `openPanel`: it would have zero callers.

### 5.3 `apps/web/src/ru-fork/rightPanel/OverlayPanelHost.tsx`

> **One shared host** for all overlays (not one mount per entry). This is what makes the
> transitions read well: open→close keeps the active panel's content mounted through the
> slide-out (the real panel, not an empty shell), switching overlays keeps the slot open and
> swaps content in place, and there's a **single** gap element so the main column animates
> once. Width + remembered resize follow the active panel (option B): the sidebar's resize
> effect re-reads the active `storageKey` on swap and animates `--sidebar-width`.

```tsx
import { useRef } from "react";

import { RightInlineSidebar } from "~/components/RightInlineSidebar";
import { RightPanelSheet } from "~/components/RightPanelSheet";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { OVERLAY_PANELS, type OverlayPanel } from "./registry";
import { useRightPanelStore } from "./store";

export function OverlayPanelHost() {
  const open = useRightPanelStore((state) => state.open);
  const close = useRightPanelStore((state) => state.close);
  const shouldUseSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);

  // Remember the last opened panel so its content stays rendered while the slot
  // slides closed (`open` is null during the close transition).
  const lastShownRef = useRef<OverlayPanel | null>(open);
  if (open !== null) {
    lastShownRef.current = open;
  }

  const activeId = open ?? lastShownRef.current;
  const active = activeId === null ? null : OVERLAY_PANELS.find((panel) => panel.id === activeId);
  if (!active) {
    return null;
  }

  const isOpen = open !== null;
  const form = shouldUseSheet ? "sheet" : "sidebar";
  const content = active.render(form, close);

  if (shouldUseSheet) {
    return (
      <RightPanelSheet open={isOpen} onClose={close}>
        {content}
      </RightPanelSheet>
    );
  }

  return (
    <RightInlineSidebar
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
      storageKey={active.width.storageKey}
      defaultWidth={active.width.defaultWidth}
      minWidth={active.width.minWidth}
      maxWidth={active.width.maxWidth}
    >
      {content}
    </RightInlineSidebar>
  );
}
```

### 5.4 `apps/web/src/ru-fork/rightPanel/index.ts`

```ts
/**
 * Right-panel coordinator (ru-fork) — single source of truth for which global
 * overlay panel is open, plus the panel registry. See ./store for the diff contract.
 */

export { useRightPanelStore } from "./store";
export { OverlayPanelHost } from "./OverlayPanelHost";
export { OVERLAY_PANELS, type OverlayPanel } from "./registry";
```

> Barrel exports only what's consumed across module boundaries: the store hook, the mount,
> the registry array, and the `OverlayPanel` type. The other registry types
> (`OverlayPanelEntry`/`OverlayPanelForm`/`OverlayPanelWidth`) are imported **directly** from
> `./registry` by same-module files (`store.ts`, `OverlayPanelMount.tsx`), so re-exporting
> them here would be unused surface.

### 5.5 `apps/web/src/components/RightInlineSidebar.tsx`

> Note: `./ui/sidebar` (relative) — `components/` convention.

```tsx
import type { CSSProperties, ReactNode } from "react";

import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";

// ru-fork: single generic shell for the right-side inline sidebars (diff + overlays).
// Replaces three byte-identical wrappers — callers differ only in width constants,
// the storage key, an optional shouldAcceptWidth guard, and the (already open-gated)
// children they render.
export function RightInlineSidebar({
  open,
  onOpenChange,
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  shouldAcceptWidth,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storageKey: string;
  defaultWidth: string;
  minWidth: number;
  maxWidth: number;
  shouldAcceptWidth?: (args: { nextWidth: number; wrapper: HTMLElement }) => boolean;
  children: ReactNode;
}) {
  return (
    <SidebarProvider
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      className="min-h-0 w-auto flex-none bg-transparent"
      style={{ "--sidebar-width": defaultWidth } as CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          maxWidth,
          minWidth,
          ...(shouldAcceptWidth ? { shouldAcceptWidth } : {}),
          storageKey,
        }}
      >
        {children}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
}
```

---

## 6. EDITED FILES (before → after)

### 6.1 `apps/web/src/ru-fork/mcp-manage/store.ts` — drop `panelOpen`

**Before** (doc + interface + impl head):
```ts
 * (atoms in rpc/mcpState + the 5 mcp.* orchestration commands). This store holds
 * ONLY ephemeral UI state — which panel/tab/selection is open. The pure
 * selectors below operate on the UI view-types the hooks produce.
 */

import { create } from "zustand";
import type { McpPanelTab, McpProjectBinding, McpRegistryServer } from "./types";

interface McpManagerState {
  readonly panelOpen: boolean;
  readonly activeTab: McpPanelTab;
  readonly selectedServerId: string | null;
  readonly selectedProjectId: string;

  readonly setPanelOpen: (open: boolean) => void;
  readonly togglePanel: () => void;
  readonly setActiveTab: (tab: McpPanelTab) => void;
  readonly selectServer: (serverId: string | null) => void;
  readonly selectProject: (projectId: string) => void;
}

export const useMcpManagerStore = create<McpManagerState>()((set) => ({
  panelOpen: false,
  activeTab: "registry",
  selectedServerId: null,
  selectedProjectId: "",

  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),
  setActiveTab: (tab) => set({ activeTab: tab }),
  selectServer: (serverId) => set({ selectedServerId: serverId }),
  selectProject: (projectId) => set({ selectedProjectId: projectId }),
}));
```

**After:**
```ts
 * (atoms in rpc/mcpState + the 5 mcp.* orchestration commands). This store holds
 * ONLY ephemeral tab/selection state. Panel open/close (and MCP⊕Pixso mutual
 * exclusion) lives in the shared right-panel coordinator (ru-fork/rightPanel).
 * The pure selectors below operate on the UI view-types the hooks produce.
 */

import { create } from "zustand";
import type { McpPanelTab, McpProjectBinding, McpRegistryServer } from "./types";

interface McpManagerState {
  readonly activeTab: McpPanelTab;
  readonly selectedServerId: string | null;
  readonly selectedProjectId: string;

  readonly setActiveTab: (tab: McpPanelTab) => void;
  readonly selectServer: (serverId: string | null) => void;
  readonly selectProject: (projectId: string) => void;
}

export const useMcpManagerStore = create<McpManagerState>()((set) => ({
  activeTab: "registry",
  selectedServerId: null,
  selectedProjectId: "",

  setActiveTab: (tab) => set({ activeTab: tab }),
  selectServer: (serverId) => set({ selectedServerId: serverId }),
  selectProject: (projectId) => set({ selectedProjectId: projectId }),
}));
```
*(selectors below are unchanged.)*

### 6.2 `apps/web/src/ru-fork/pixso-move/store.ts` — drop `panelOpen`/`openPanel`/`closePanel`

**Before (header doc):**
```ts
 * Pixso Move — UI + settings store (zustand). Mirrors the MCP manager store: panel open
 * state + a small master→detail view machine, plus the designer's settings persisted to
 * localStorage (the web app is not sandboxed, so localStorage is safe here).
 */
```
**After:**
```ts
 * Pixso Move — UI + settings store (zustand). Mirrors the MCP manager store: a small
 * master→detail view machine, plus the designer's settings persisted to localStorage
 * (the web app is not sandboxed, so localStorage is safe here). Panel open/close (and
 * MCP⊕Pixso mutual exclusion) lives in the shared right-panel coordinator
 * (ru-fork/rightPanel), not here.
 */
```

**Before (interface + impl):**
```ts
interface PixsoStore {
  readonly panelOpen: boolean;
  readonly view: PixsoView;
  readonly selectedNodeId: string | null;
  /** Bumped by the refresh button; gates the gallery query (manual refresh only). */
  readonly refreshNonce: number;
  readonly settings: PixsoSettings;

  readonly openPanel: () => void;
  readonly closePanel: () => void;
  readonly openSettings: () => void;
  readonly openNode: (nodeId: string) => void;
  readonly backToGallery: () => void;
  readonly refresh: () => void;
  readonly updateSettings: (patch: Partial<PixsoSettings>) => void;
}

export const usePixsoStore = create<PixsoStore>()((set) => ({
  panelOpen: false,
  view: "gallery",
  selectedNodeId: null,
  refreshNonce: 0,
  settings: loadSettings(),

  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  openSettings: () => set({ view: "settings" }),
```
**After:**
```ts
interface PixsoStore {
  readonly view: PixsoView;
  readonly selectedNodeId: string | null;
  /** Bumped by the refresh button; gates the gallery query (manual refresh only). */
  readonly refreshNonce: number;
  readonly settings: PixsoSettings;

  readonly openSettings: () => void;
  readonly openNode: (nodeId: string) => void;
  readonly backToGallery: () => void;
  readonly refresh: () => void;
  readonly updateSettings: (patch: Partial<PixsoSettings>) => void;
}

export const usePixsoStore = create<PixsoStore>()((set) => ({
  view: "gallery",
  selectedNodeId: null,
  refreshNonce: 0,
  settings: loadSettings(),

  openSettings: () => set({ view: "settings" }),
```
*(remaining actions unchanged.)*

### 6.3 `apps/web/src/ru-fork/pixso-move/components/PixsoNavGroup.tsx` — render nav from the registry (toggle + active highlight)

**Before:**
```tsx
import { LayersIcon, ServerIcon } from "lucide-react";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar";
import { usePixsoStore } from "../store";

/**
 * Left-nav block (under search, above the projects list): "Макеты Pixso" opens the right
 * panel; "MCP Серверы" is an inert placeholder for now (does nothing).
 */
export function PixsoNavGroup() {
  const openPanel = usePixsoStore((state) => state.openPanel);

  return (
    <SidebarGroup className="px-2 pt-1 pb-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="gap-2 px-2 py-1.5"
            onClick={openPanel}
            data-testid="pixso-move-nav"
          >
            <LayersIcon className="size-3.5" />
            <span className="flex-1 truncate text-left text-xs">Макеты Pixso</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton size="sm" className="gap-2 px-2 py-1.5 text-muted-foreground/70">
            <ServerIcon className="size-3.5" />
            <span className="flex-1 truncate text-left text-xs">MCP Серверы</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}
```
**After** (data-driven — one button per registry entry; adding a panel needs no change here):
```tsx
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar";
import { OVERLAY_PANELS, useRightPanelStore } from "~/ru-fork/rightPanel";

/**
 * Left-nav block (under search, above the projects list): one button per global
 * overlay panel (from OVERLAY_PANELS). Each toggles its right panel (click again to
 * close) and is highlighted while open; the coordinator keeps only one open at a time.
 */
export function PixsoNavGroup() {
  const openPanel = useRightPanelStore((state) => state.open);
  const toggle = useRightPanelStore((state) => state.toggle);

  return (
    <SidebarGroup className="px-2 pt-1 pb-0">
      <SidebarMenu>
        {OVERLAY_PANELS.map((panel) => {
          const Icon = panel.icon;
          return (
            <SidebarMenuItem key={panel.id}>
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5"
                isActive={openPanel === panel.id}
                onClick={() => toggle(panel.id)}
                data-testid={`overlay-nav-${panel.id}`}
              >
                <Icon className="size-3.5" />
                <span className="flex-1 truncate text-left text-xs">{panel.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}
```

> `() => toggle(panel.id)` is a per-render closure, but it's a handful of nav buttons
> (not a hot path) and `SidebarMenuButton` isn't memoized on it — negligible. The nav
> re-renders only when `open` changes (needed to refresh `isActive`).

### 6.4 `apps/web/src/ru-fork/mcp-manage/components/McpPanelMount.tsx` — **DELETED**

No per-feature mount files in the registry design — the registry entry + `OverlayPanelMount`
replace them. See §7. (`PixsoPanelMount` is likewise **not** created.)

### 6.5 `apps/web/src/components/AppSidebarLayout.tsx`

**Before (imports 4–13):**
```tsx
import ThreadSidebar from "./Sidebar";
import { RightPanelSheet } from "./RightPanelSheet";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { PixsoPanel, PixsoPanelInlineSidebar, usePixsoStore } from "../ru-fork/pixso-move";
import {
  clearShortcutModifierState,
  syncShortcutModifierStateFromKeyboardEvent,
} from "../shortcutModifierState";
```
**After:**
```tsx
import ThreadSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";
import { OverlayPanelHost } from "../ru-fork/rightPanel";
import {
  clearShortcutModifierState,
  syncShortcutModifierStateFromKeyboardEvent,
} from "../shortcutModifierState";
```

**Before (body 19–22):**
```tsx
  const navigate = useNavigate();
  const pixsoOpen = usePixsoStore((state) => state.panelOpen);
  const closePixso = usePixsoStore((state) => state.closePanel);
  const useRightPanelSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
```
**After:**
```tsx
  const navigate = useNavigate();
```

**Before (JSX 74–82):**
```tsx
      {children}
      {useRightPanelSheet ? (
        <RightPanelSheet open={pixsoOpen} onClose={closePixso}>
          <PixsoPanel onClose={closePixso} mode="sheet" />
        </RightPanelSheet>
      ) : (
        <PixsoPanelInlineSidebar open={pixsoOpen} onClose={closePixso} />
      )}
    </SidebarProvider>
```
**After** (one shared host — adding a panel needs no change here):
```tsx
      {children}
      {/* ru-fork: one shared host for all global overlay panels, mounted once outside
          the routes so it never remounts on navigation. The coordinator decides which
          entry is shown; the host keeps the slot open across swaps and keeps content
          mounted through the close slide. */}
      <OverlayPanelHost />
    </SidebarProvider>
```

### 6.6 `apps/web/src/routes/_chat.tsx` — MCP mount moves to the layout

**Before (import 17–19):**
```tsx
import { useActiveProjectRef } from "~/hooks/useActiveProject";
import { McpPanelMount } from "../ru-fork/mcp-manage";
import { getPrimaryEnvironmentConnection } from "../environments/runtime";
```
**After:**
```tsx
import { useActiveProjectRef } from "~/hooks/useActiveProject";
import { getPrimaryEnvironmentConnection } from "../environments/runtime";
```

**Before (JSX 121–131):**
```tsx
function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <McpActiveProjectSync />
      <Outlet />
      {/* ru-fork: single MCP panel mount for all chat routes (draft + thread) —
          hoisted here so it never remounts on navigation. */}
      <McpPanelMount />
    </>
  );
}
```
**After:**
```tsx
function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <McpActiveProjectSync />
      <Outlet />
      {/* ru-fork: the MCP + Pixso overlay panels are mounted once in
          AppSidebarLayout (coordinator-driven), not here. */}
    </>
  );
}
```

### 6.7 `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`

**(a) Imports 24–26.** Before:
```tsx
import { RightPanelSheet } from "../components/RightPanelSheet";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";
import { useMcpManagerStore } from "../ru-fork/mcp-manage";
```
After (route convention = relative `../components/...`; only `SidebarInset` still needed):
```tsx
import { RightPanelSheet } from "../components/RightPanelSheet";
import { RightInlineSidebar } from "../components/RightInlineSidebar";
import { SidebarInset } from "../components/ui/sidebar";
import { useRightPanelStore } from "../ru-fork/rightPanel";
```

**(b) `DiffPanelInlineSidebar` return — lines 116–139.** Before:
```tsx
  return (
    <SidebarProvider
      defaultOpen={false}
      open={diffOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          maxWidth: DIFF_INLINE_SIDEBAR_MAX_WIDTH,
          minWidth: DIFF_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {renderDiffContent ? <LazyDiffPanel mode="sidebar" /> : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
```
After (the `onOpenChange` + `shouldAcceptInlineSidebarWidth` callbacks above are unchanged):
```tsx
  return (
    <RightInlineSidebar
      open={diffOpen}
      onOpenChange={onOpenChange}
      storageKey={DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY}
      defaultWidth={DIFF_INLINE_DEFAULT_WIDTH}
      minWidth={DIFF_INLINE_SIDEBAR_MIN_WIDTH}
      maxWidth={DIFF_INLINE_SIDEBAR_MAX_WIDTH}
      shouldAcceptWidth={shouldAcceptInlineSidebarWidth}
    >
      {renderDiffContent ? <LazyDiffPanel mode="sidebar" /> : null}
    </RightInlineSidebar>
  );
```

**(c) Coordinator wiring — lines 172–174.** Before:
```tsx
  // MCP panel open/close is global (useMcpManagerStore) and rendered once in the
  // _chat layout; here we only need the setter to keep diff + MCP mutually exclusive.
  const setMcpPanelOpen = useMcpManagerStore((store) => store.setPanelOpen);
```
After:
```tsx
  // The overlay panels (MCP/Pixso) are coordinator-driven and mounted in
  // AppSidebarLayout. Diff stays URL-driven; the two seams below keep all three
  // mutually exclusive: opening diff closes the overlay, and the effect closes
  // diff whenever an overlay opens (e.g. from the left nav).
  const overlayPanelOpen = useRightPanelStore((store) => store.open !== null);
  const closeOverlayPanel = useRightPanelStore((store) => store.close);
```

**(d) `openDiff` — line 212.** Before:
```tsx
    markDiffOpened();
    // Diff and MCP share the right-panel slot — only one open at a time.
    setMcpPanelOpen(false);
    void navigate({
```
After:
```tsx
    markDiffOpened();
    // Diff and the overlay panels share the right-panel slot — only one open.
    closeOverlayPanel();
    void navigate({
```
…and its dependency array `[markDiffOpened, navigate, setMcpPanelOpen, threadRef]` → `[markDiffOpened, navigate, closeOverlayPanel, threadRef]`.

**(e) New effect (add next to the existing effects, ~line 223, after `openDiff`):**
```tsx
  // Seam: opening an overlay panel (from the left nav) closes the diff panel.
  useEffect(() => {
    if (overlayPanelOpen && diffOpen) {
      closeDiff();
    }
  }, [overlayPanelOpen, diffOpen, closeDiff]);
```

**(f) Stale comment — line 264 (inline branch).** Before:
```tsx
        {/* ru-fork: the MCP panel is mounted once in the _chat layout (McpPanelMount). */}
```
After:
```tsx
        {/* ru-fork: the MCP/Pixso overlay panels are mounted in AppSidebarLayout, not per route. */}
```

**(g) Stale comment — line 282 (sheet branch).** Before:
```tsx
      {/* ru-fork: the MCP panel sheet is mounted once in the _chat layout. */}
```
After:
```tsx
      {/* ru-fork: the MCP/Pixso overlay panels are mounted in AppSidebarLayout, not per route. */}
```

### 6.8 `apps/web/src/components/ChatView.tsx` — drop the MCP header button, keep diff↔overlay seam

**(a) Import — line 199.** Before:
```tsx
import { useMcpManagerStore } from "../ru-fork/mcp-manage";
```
After:
```tsx
import { useRightPanelStore } from "../ru-fork/rightPanel";
```

**(b) State + toggles — lines 1599–1648.** Before:
```tsx
  const mcpPanelOpen = useMcpManagerStore((state) => state.panelOpen);
  const setMcpPanelOpen = useMcpManagerStore((state) => state.setPanelOpen);

  const onToggleDiff = useCallback(() => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
      // Diff and MCP share the right-panel slot: opening diff closes MCP.
      setMcpPanelOpen(false);
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId,
        threadId,
      },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen ? { ...rest, diff: undefined } : { ...rest, diff: "1" };
      },
    });
  }, [
    diffOpen,
    environmentId,
    isServerThread,
    navigate,
    onDiffPanelOpen,
    setMcpPanelOpen,
    threadId,
  ]);

  const onToggleMcp = useCallback(() => {
    const next = !mcpPanelOpen;
    setMcpPanelOpen(next);
    // Mutual exclusion with the diff panel: opening MCP closes diff.
    if (next && diffOpen) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
        replace: true,
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return { ...rest, diff: undefined };
        },
      });
    }
  }, [diffOpen, environmentId, mcpPanelOpen, navigate, setMcpPanelOpen, threadId]);
```
After (drop `mcpPanelOpen`, drop `onToggleMcp` entirely; `onToggleDiff` closes the overlay via the coordinator):
```tsx
  const closeOverlayPanel = useRightPanelStore((state) => state.close);

  const onToggleDiff = useCallback(() => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
      // Diff and the overlay panels share the right-panel slot: opening diff
      // closes whichever overlay (MCP/Pixso) is open.
      closeOverlayPanel();
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId,
        threadId,
      },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen ? { ...rest, diff: undefined } : { ...rest, diff: "1" };
      },
    });
  }, [
    diffOpen,
    environmentId,
    isServerThread,
    navigate,
    onDiffPanelOpen,
    closeOverlayPanel,
    threadId,
  ]);
```

**(c) ChatHeader props — lines 3636–3648.** Remove `mcpPanelOpen={mcpPanelOpen}` (3637) and `onToggleMcp={onToggleMcp}` (3648). All other props unchanged.

### 6.9 `apps/web/src/components/chat/ChatHeader.tsx` — remove the MCP toggle

**(a) Icon import — line 12.** Before:
```tsx
import { BoxesIcon, DiffIcon, SparklesIcon, TerminalSquareIcon } from "lucide-react";
```
After (`BoxesIcon` no longer used):
```tsx
import { DiffIcon, SparklesIcon, TerminalSquareIcon } from "lucide-react";
```

**(b) Props interface — remove line 39 `mcpPanelOpen: boolean;` and line 49 `onToggleMcp: () => void;`.**

**(c) Destructure — remove line 70 `mcpPanelOpen,` and line 79 `onToggleMcp,`.**

**(d) MCP `Toggle` block — remove lines 180–196 entirely:**
```tsx
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={mcpPanelOpen}
                onPressedChange={onToggleMcp}
                aria-label="Toggle MCP panel"
                variant="outline"
                size="xs"
              >
                <BoxesIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">Показать/скрыть панель MCP-серверов</TooltipPopup>
        </Tooltip>
```
*(The diff `Toggle` directly above and the advanced-chat `Toggle` directly below are unchanged.)*

### 6.10 Barrels

`apps/web/src/ru-fork/mcp-manage/index.ts` — **remove** two lines (the inline-sidebar export and the now-deleted mount):
```ts
export { McpPanelInlineSidebar } from "./components/McpPanelInlineSidebar";
export { McpPanelMount } from "./components/McpPanelMount";
```
*(`McpPanel` and the store/selectors/type exports stay.)*

`apps/web/src/ru-fork/pixso-move/index.ts` — **remove** line (no `PixsoPanelMount` replacement — there is no per-feature mount in the registry design):
```ts
export { PixsoPanelInlineSidebar } from "./components/PixsoPanelInlineSidebar";
```
*(`PixsoNavGroup`, `PixsoPanel`, `usePixsoStore` stay.)*

> Conscious decision: the barrels still export `McpPanel` / `PixsoPanel` / `usePixsoStore`.
> `registry.tsx` reaches the panels via **component-file** imports (to break the barrel cycle,
> §3), and the stores are read internally via `../store`, so these barrel exports have no
> external consumer after this change. They are kept as the modules' intentional public
> surface (re-exporting a feature's store/panel is normal) and are not lint-flagged (unused
> *exports* are not errors). No consumer change is required.

### 6.11 `apps/web/src/routes/_chat.draft.$draftId.tsx` — stale comment (lines 72–73)

**Before:**
```tsx
  // The MCP panel is mounted once in the _chat layout (McpPanelMount), so it is
  // available here on drafts too without a per-route mount.
```
**After:**
```tsx
  // The MCP + Pixso overlay panels are mounted once in AppSidebarLayout
  // (coordinator-driven), so they are available here on drafts too.
```

---

## 7. DELETED FILES

- `apps/web/src/ru-fork/mcp-manage/components/McpPanelInlineSidebar.tsx`
- `apps/web/src/ru-fork/pixso-move/components/PixsoPanelInlineSidebar.tsx`
- `apps/web/src/ru-fork/mcp-manage/components/McpPanelMount.tsx`

(The two inline sidebars are replaced by `RightInlineSidebar`; `McpPanelMount` is replaced by the registry entry + `OverlayPanelMount` — and no `PixsoPanelMount` is created.)

---

## 8. Mutual-exclusion behavior matrix

| Action | diff (`?diff`) | overlay (`store.open`) | Mechanism |
|---|---|---|---|
| Click nav "MCP" while nothing open | — | `mcp` | `toggle("mcp")` |
| Click nav "MCP" while MCP open | — | `null` | `toggle("mcp")` (req #5) |
| Click nav "Pixso" while MCP open | — | `pixso` | single enum ⇒ MCP auto-closes |
| Toggle diff while Pixso open | `1` | `null` | `onToggleDiff` → `closeOverlayPanel()` |
| Click nav "MCP" while diff open | `undefined` | `mcp` | route effect: overlay open ⇒ `closeDiff()` |
| Toggle diff off | `undefined` | unchanged | normal diff toggle |

No loops: opening diff sets overlay `null` (effect no-op); opening overlay clears diff (overlay stays open).

---

## 9. Verification

- `tsc` typecheck (web) — expect 0 errors; confirms all removed store fields / props / imports are fully unreferenced. (tsconfig sets neither `noUnusedLocals` nor `noUnusedParameters`.)
- `oxlint` (repo `.oxlintrc.json`, categories warn) — no unused imports (`BoxesIcon` in ChatHeader; `Sidebar`/`SidebarProvider`/`SidebarRail`/`RightPanelSheet`/`useMediaQuery`/`RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY` in AppSidebarLayout). The registry's `render: (form, onClose) => …` where the MCP entry ignores `form` is safe: `no-unused-vars` uses `args: after-used` and `form` precedes the used `onClose`.
- No import cycle: `store → registry → {McpPanel, PixsoPanel}` (component-file imports), `OverlayPanelMount → {store, registry}`, `nav/layout → registry`. Confirm `madge`/manual: nothing in `rightPanel` imports a feature **barrel**.
- Re-render check (React DevTools): toggling MCP re-renders only the MCP + previously-open mounts, not all of `OVERLAY_PANELS`.
- Manual: nav toggles open/close + highlight; opening any one of {diff, …overlays} closes the others; nav state (MCP tab/selection, Pixso view/node) is retained across close→reopen and across switching panels; diff still deep-links via `?diff=1` and is thread-only; narrow layout still gets sheets.
- Completeness greps (run from `apps/web/src`, must return nothing):
  - `grep -rn "panelOpen\|McpPanelInlineSidebar\|PixsoPanelInlineSidebar\|McpPanelMount\|PixsoPanelMount\|onToggleMcp\|setMcpPanelOpen\|mcpPanelOpen" .`
  - `grep -rn "_chat layout" .` (no stale mount-location comments)
  - `grep -rn "BoxesIcon" .` (icon fully removed)

---

## 10. File summary

**New (5):** `ru-fork/rightPanel/{registry.tsx,store.ts,OverlayPanelHost.tsx,index.ts}`, `components/RightInlineSidebar.tsx`.
**Edited (11):** mcp store, pixso store, `PixsoNavGroup`, `AppSidebarLayout`, `_chat.tsx`, `_chat.$environmentId.$threadId.tsx` (incl. 2 stale comments), `_chat.draft.$draftId.tsx` (stale comment), `ChatView`, `ChatHeader`, + 2 barrels (`mcp-manage/index.ts`, `pixso-move/index.ts`).
**Deleted (3):** `McpPanelInlineSidebar.tsx`, `PixsoPanelInlineSidebar.tsx`, `McpPanelMount.tsx`.
