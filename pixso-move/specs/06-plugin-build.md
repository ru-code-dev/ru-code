# Task 6 — Plugin build & vendored UI kit (`@pixso-move/plugin`)

Set up the two-bundle Pixso plugin build and vendor ru-fork web's UI kit so the iframe UI looks
**identical** to ru-fork. No app logic yet (tasks 7–8) — this task produces a buildable shell with
the design system in place.

## File budget (authored; vendored UI files exempt per conventions §2.3)
| Path | Responsibility | LOC |
|---|---|---|
| `vite.code.config.ts` | sandbox IIFE build | ~25 |
| `vite.ui.config.ts` | iframe React+Tailwind single-file build | ~20 |
| `manifest.json` | Pixso plugin manifest | ~8 |
| `src/ui/index.html` | iframe host (`data-theme`/`dark`) | ~20 |
| `src/ui/main.tsx` | React mount | ~10 |
| `src/ui/lib/utils.ts` | vendored `cn` (stripped) | ~6 |
| `src/ui/components/ui/*.tsx` | **vendored** (button/input/label/field/card) | exempt |
| `src/ui/index.css`, `src/ui/themes/ru-fork.css` | **vendored** css/theme | exempt |

All **authored** plugin files obey the 150-LOC cap. App/screen/code decomposition is in
[07](./07-plugin-code.md) / [08](./08-plugin-ui.md).

## Pixso plugin model (two bundles)
A Pixso plugin (Figma-compatible API) ships two artifacts declared in `manifest.json`:
- **`main`** → `dist/code.js` — runs in the **sandbox** (the `pixso`/`figma` main thread; has the
  node API; **no** DOM). Built as a single IIFE.
- **`ui`** → `dist/ui.html` — runs in an **iframe** (full DOM/React; **no** node API). Built as one
  self-contained HTML (JS+CSS inlined via `vite-plugin-singlefile`).
They communicate only via `postMessage` (task 7).

## manifest.json
```json
{
  "name": "PixsoMove",
  "id": "REPLACE_WITH_PIXSO_PLUGIN_ID",
  "api": "2.0.0",
  "editorType": ["pixso"],
  "main": "dist/code.js",
  "ui": "dist/ui.html"
}
```
(Format verified against the reference `pixso-plugin/manifest.json`.)

## Vite configs (two)
**`vite.code.config.ts`** — sandbox bundle (IIFE, no externals, minified):
```ts
export default defineConfig({
  build: {
    target: "esnext", minify: true, emptyOutDir: false, outDir: "dist",
    lib: { entry: "src/code/code.ts", name: "__pixsoPlugin", formats: ["iife"], fileName: () => "code.js" },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
```
**`vite.ui.config.ts`** — iframe bundle (React + Tailwind v4 + single-file):
```ts
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
export default defineConfig({
  root: "src/ui",
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: { alias: { "~": path.resolve(import.meta.dirname, "src/ui") } }, // mirror ru-fork "~/"
  build: { target: "esnext", outDir: "../../dist", emptyOutDir: false,
           rollupOptions: { input: "src/ui/index.html" } },
});
```
> Two configs because the two bundles have **opposite** constraints (no-DOM IIFE vs React SPA).
> Verified against the reference plugin's `vite.code.config.ts`/`vite.ui.config.ts`.

## Vendored UI kit (copied from `apps/web`, must stay identical)
Copy these into `src/ui/` and rewrite imports (`~/lib/utils` works via the `~` alias):

| Source (apps/web) | Dest (plugin) | Notes |
|---|---|---|
| `src/lib/utils.ts` → just `cn()` | `src/ui/lib/utils.ts` | **strip** the `@t3tools/contracts` import + the id helpers; keep only `cn` (cx + twMerge) |
| `src/components/ui/button.tsx` | `src/ui/components/ui/button.tsx` | verbatim |
| `src/components/ui/input.tsx` | `src/ui/components/ui/input.tsx` | verbatim |
| `src/components/ui/label.tsx` | `src/ui/components/ui/label.tsx` | verbatim |
| `src/components/ui/field.tsx` | `src/ui/components/ui/field.tsx` | verbatim |
| `src/components/ui/card.tsx` | `src/ui/components/ui/card.tsx` | verbatim |
| `src/index.css` | `src/ui/index.css` | keep `@import "tailwindcss"`, the `@theme inline` token map, the `@layer base`, and the cross-theme fallbacks. **Drop** imports of themes we don't ship (keep only `./themes/ru-fork.css`). |
| `src/themes/ru-fork.css` | `src/ui/themes/ru-fork.css` | verbatim (light + dark blocks) |

Exact dep versions (must match `apps/web` so classes/tokens render identically):
`react@19.2.5`, `react-dom@19.2.5`, `@base-ui/react@1.4.1`, `class-variance-authority@0.7.1`,
`tailwind-merge@3.4.0`, `lucide-react@0.564.0`, `tailwindcss@4.2.4`, `@tailwindcss/vite@4.2.4`,
`vite@8.0.10`.

> **Why copy, not import:** the plugin is a separate vite build that can't pull from the `apps/web`
> app (router/store/effect deps). Per the project rule, we vendor the **presentational** components
> (they only need `@base-ui/react` + `cn`). Mark each copied file with a header comment
> `// pixso-move: vendored from apps/web/src/components/ui/<f>.tsx — keep in sync`.

## index.html (iframe host)
`src/ui/index.html` sets `data-theme="ru-fork"` + `class="dark"` on `<html>` (so tokens resolve),
imports `index.css`, mounts `#root`, and loads `main.tsx`. Body uses the same font stack as
ru-fork (DM Sans) for parity; bundle the font or fall back to system if offline (corporate).

## TDD / validation
Plugin is exempt from the 100% rule (no Pixso runtime here), **but**:
- `pnpm --filter @pixso-move/plugin typecheck` → 0 errors (the vendored components must typecheck
  against `@base-ui/react@1.4.1`).
- `oxlint` → 0 errors on `src/`.
- `pnpm --filter @pixso-move/plugin build` produces `dist/code.js` + `dist/ui.html`.
- A pure-logic unit test target *is* added in task 7 for the sandbox helpers.

## Acceptance
- [ ] `build` emits `dist/code.js` (IIFE) + `dist/ui.html` (single file).
- [ ] Vendored components typecheck & lint clean; tokens/classes render (manual eyeball in task 9).
- [ ] Only the `ru-fork` theme is shipped; UI matches ru-fork visually.
