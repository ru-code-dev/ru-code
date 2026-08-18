# @ru-code/localization — bilingual (RU/EN) runtime

Ru Code ships **English source** (byte-identical to upstream t3) and injects Russian at
**build time** from a dictionary. Nothing is ever written to the `.ts`/`.tsx` source — the
Russian lives only in (a) the built bundle and (b) the `dict/` JSON. That keeps the fork diff
tiny and upstream syncs clean.

**Both bundles are covered.** The transform runs under Vite for the **web** app AND under
`vp pack` (tsdown/rolldown) for the **server** CLI — it is wired into the `pack` config in
`apps/server/vite.config.ts`, so server-side strings (providers, CLI `--help`, startup,
bundled `packages/*`) ship Russian too, not just the web UI. A build gate then **proves, per
translation, that every one landed** — see [Build-time enforcement](#build-time-enforcement).

---

## How this is versioned — two lanes (read this first)

Localization is split into **engine** (code, committed) and **dictionary** (data, NOT committed):

|                | what                                                                                    | in git?                                | how it changes                                                                                          |
| -------------- | --------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Engine**     | package `src/`+`build/` (transform, gate, catalog), wiring, root scripts, the ~13 seams | **yes** — a single localization commit | a _targeted_ engine fix is folded into that one commit → everything above it rebases (rare, deliberate) |
| **Dictionary** | `ru-code/localization/dict/**` (+ `MISSING.md`, `catalog.generated.json`)               | **no** — git-ignored                   | you edit the files; **no commit** (later: its own repo)                                                 |

> `build/**` is deliberately re-included from the repo-wide `build/` ignore (see the negation
> in `.gitignore`) — the engine is source and must be committed; only `catalog.generated.json`
> (regenerated every build) and `dict/` stay ignored.

So there are exactly two flows:

- **Add / change a translation** → edit a file under `dict/` → `pnpm localize:check`. **Done — nothing to commit** (the dict is git-ignored; the build reads it straight from disk).
- **Change the engine** (transform, a seam, wiring) → edit the engine files → fold into the localization commit (`git commit --amend` / fixup) and **rebase the commits above it**. This is the only time anything rebases.

> ⚠️ The dict is git-ignored, so it lives **only on disk** right now — not backed up by the
> fork and absent from fresh clones (which then build English-only). Keep a copy until it is
> promoted to its own repo. Nothing else here changes when that happens.

---

## Mental model (read this first)

- **Source stays English.** The transform rewrites, _in memory during the build_, each
  translated display string into `L("Save", "Сохранить")` (or `LT(...)` for templates) —
  **both languages inlined** as literal call args. No file on disk changes.
- **Runtime is a branch, not a lookup.** `L(en, ru)` = `getLocale() === "en" ? en : ru`.
  No JSON is loaded in the browser, no keys. `L(en, ru) === en` in English locale, so the
  built app in English is behaviourally identical to the original source.
- **The dictionary is data.** `dict/<path-to-source-file>.json` holds the translations for
  that file. The **file path is the scope**, so entries are just `{ en, ru, kind }`.
- **The transform locates per file.** When the build processes a file that has dict entries,
  it parses that one file, finds the display nodes, and applies. Files with no entries are
  skipped in O(1). This is incremental (dev HMR re-localizes only the edited file) and never
  uses a stale catalog.

```
dict/apps/web/src/components/Sidebar.tsx.json   <- translations for Sidebar.tsx
  [{ "en": "Save", "ru": "Сохранить", "kind": "str" }]
```

- `kind`: `"str"` (string literal / JSX attr) . `"jsx"` (JSX text) . `"tpl"` (template,
  `en`/`ru` are `{0}`-placeholder skeletons, e.g. `"Found {0} files" / "Найдено {0} файлов"`).
- `nth` (optional): pins one occurrence when a file maps the same English to different
  Russian, or translated only some occurrences. Keeps placement lossless.
- **Plural/structural seams** (~13 files, marked `// ru-code:`) are the only real source
  edits — English has no three-form plural, so they call `pluralRu` / `Lp` / `L` directly.
  `apps/server` has **zero seams** (100% dict-driven).
- **Locale** is a persisted `ServerSettings.locale` (default Russian). The web toggle
  (Settings -> Язык) writes it; the server reads it back (`serverSettings.ts` taps). Under
  `vitest` the default is English so the suite runs as the EN-identity proof.

---

## Agent runbooks

### Add a new translation

1. Find the file and the exact English string.
2. Append to `ru-code/localization/dict/<that-file>.json` (create the file if absent):
   `{ "en": "<exact English>", "ru": "<Russian>", "kind": "str" | "jsx" | "tpl" }`.
   - template? `en`/`ru` use `{0}`,`{1}` for the interpolations.
   - only _some_ occurrences, or same English -> different Russian in one file? add `"nth": <index>`.
3. `pnpm localize:check` -> must say the entry placed. Done.
   (Plural or logic-coupled string -> add a `// ru-code:` seam instead.)

### Change an existing translation

Edit the `ru` (or `en`) in that file's `dict/<file>.json`. `pnpm localize:check`.

### Find what still needs translating

- One PR / commit range: `pnpm localize:new --range <A> <B>` (fast; only changed files).
- Whole surface: `pnpm localize:new` -> writes `MISSING.md` (heuristic backlog; excludes
  mobile/desktop/tests/generated/non-display; ranked high->low; `--all` adds low-confidence).

### Fix drift after an upstream sync (the reconciliation protocol)

Localization is validated **once, at the end**, not per replayed commit — and that costs
nothing, because the two concerns live at different layers:

- **Per commit, during replay:** validate with the **test suite** (source correctness,
  bisectable). Tests run in EN where `L(en,ru) === en`, and they never trigger the build gate
  (`generateBundle` is a bundle hook, not a test hook), so localization is transparent —
  intermediate commits stay green regardless of how complete the accumulated dict is. The
  transform also just skips entries whose source isn't present yet at that commit; it never
  throws. (If you _build_ an intermediate commit, the `FAIL_ON_LOCALIZATION_ERROR` switch keeps
  the gate lenient there — branding isn't applied yet, so the constant is absent.)
- **Once, at HEAD (full series applied, branding present, constant `true`):** run the
  reconciliation below. Now every string exists, so every unapplied entry is unambiguously a
  real drift, the strict gate hard-fails on it, and `localize:check` names each one — no
  per-commit bisection, each thing fixed exactly once.

```
1. Cherry-pick the localization ENGINE commit onto the new t3 (it goes FIRST).
2. Resolve any seam-file patch conflicts - re-apply the // ru-code: edit onto the new code.
     (This is an ENGINE change -> it's folded into the localization commit; commits above rebase.)
3. Replay the remaining fork commits; keep each green via the TEST suite (not the build gate).
4. At HEAD: pnpm localize:fix   -> auto-relocates every MOVED entry (safe; they already land).
5. pnpm localize:check   -> for whatever remains, edit the git-ignored dict/ files:
     AMBIGUOUS  -> the string is now in several files. Set its scope to the right file
                  (move the entry to that file's dict json); if it legitimately appears in
                  several, add one entry per file. Mobile/desktop are ignored.
     UNLOCATED  -> the English changed or was removed:
                    - reworded -> update the entry's `en` (and `ru` if meaning changed)
                    - removed  -> delete the entry
6. pnpm localize:check   -> repeat until "every dictionary entry placed cleanly".
7. pnpm localize:new --range <base>..<tip>   -> translate genuinely new UI strings.
8. pnpm build (strict gate ON) + test suite green.  Tip: `git diff <old-fork-HEAD> HEAD` on
     source shows exactly what t3 reworded and WHY a string stopped landing.
   (dict edits in steps 4-7 are NOT committed - dict/ is git-ignored.)
```

**Why this works with moving code:** binding is by `(kind, en, scope)` with fresh offsets,
so a string that just _moved lines_ re-locates silently. A string that moved to another
**file** is found tree-wide, still applied, and reported `MOVED old -> new`. Only genuinely
reworded/removed strings need a human, and each is reported with its file.

---

## Command reference

| command                                   | what it does                                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm localize:check`                     | Locate all entries; report MOVED / AMBIGUOUS / UNLOCATED; **plus the dictionary-integrity gate** (`dictLint.mjs`) that fails on alignment-slip corruption. Exit non-zero on any. The drift gate. |
| `pnpm localize:fix`                       | Auto-relocate MOVED entries to their new file (safe), then re-check.                                                                                                                             |
| `pnpm localize:new [--range A B] [--all]` | Find untranslated user-facing strings -> `MISSING.md`. Default whole repo; `--range` for a PR.                                                                                                   |
| `pnpm localize:stats`                     | Dictionary coverage snapshot (entries by area/kind).                                                                                                                                             |
| `pnpm localize:catalog`                   | Build the catalog (debug view of what places); the transform itself locates per-file.                                                                                                            |
| `pnpm localize:extract`                   | One-time bootstrap - rebuild the whole `dict/` tree from the l10n PR. Overwrites.                                                                                                                |
| `pnpm localize:verify-pr`                 | Bootstrap check only - proves the dict+locator reproduce the l10n PR exactly (0 miss, 0 over-wrap). Meaningful only on the PR base commit, not after a sync.                                     |
| `pnpm localize:verify-build`              | The independent build backstop (run standalone against `apps/server/dist`): greps the emitted JS for localized pairs, fails if a whole target has none. Runs automatically inside `pnpm build`.  |
| `pnpm localize:revert`                    | Print the localization footprint; `--force` restores files to English + removes the package.                                                                                                     |

---

## Guarantees

- **EN-identity:** the app suite runs through the transform in English (the `vitest` default);
  passing proves the transform + seams changed no behaviour.
- **No over-wrap:** `nodes.mjs` only ever wraps display-position nodes - never object keys,
  types, module specifiers, `case`/`===` operands, or seam-owned text. `verify-pr` proves,
  on the PR base, that the locator wraps _exactly_ the PR's translated nodes and no more.
- **Resync-safe:** offsets are recomputed every build; the dict, not the commit, is the source
  of truth; anything a sync breaks is reported with a file and an action.

### Build-time enforcement

Two automatic gates run on every `pnpm build` — no manual command, no sampling — so a
translation can never silently ship English:

1. **Per-translation gate** (`build/vitePlugin.mjs`, `generateBundle`, runs under both Vite
   and `vp pack`). For every dictionary-scoped file that actually survives into the output
   (`chunk.modules` — so **tree-shaken / dead code is skipped, by design**), it asserts every
   one of that file's entries placed. If the transform never ran on a bundled file, or an
   entry didn't match a source node (reworded / removed / mis-scoped), the build **fails and
   lists every unapplied line at once** (`file :: "en" → "ru" — …`). Because a placed entry is
   rendered as `L(en,ru)` and a bundler only drops _dead_ code, "placed + shipped" ⟹ "Russian
   in the bundle" _by construction_ — this is a proof, not a grep guess.
2. **Independent backstop** (`build/verifyBuild.mjs`, invoked from `apps/server/scripts/cli.ts`
   after the bundles exist). With no dependency on the plugin, it greps the emitted JS for the
   `L("en","ru")` adjacency pair (unique to the transform — immune to library-string
   collisions) and fails if a whole target has **zero** pairs. This catches the one thing the
   plugin can't: the plugin never being wired into a bundler at all (the original server bug).
3. **Dictionary-integrity gate** (`build/dictLint.mjs`, run by both `localize:check` and the
   build). The two gates above prove a translation _lands_; this one proves it's _correctly
   paired_. It catches the deterministic fingerprints of an extraction alignment slip:
   `en` containing Cyrillic (an endonym treated as a source string); `en === ru`; and a **code
   discriminant** (`Schema.Literals`/union member like `"en"`) paired with a **seam's Russian**
   — the exact shape of the bug below. Legit synonyms (`Delete`/`Remove` → `Удалить`) are
   surfaced as warnings, never fatal. It does **not** catch an arbitrary mispair of two valid
   display strings — only a semantic judge can — but it makes the alignment-slip class
   impossible to reintroduce.

> **Post-mortem — the picker corruption.** The dict is bootstrapped once by aligning the
> English base against the Russian PR (`pairUnits`). Where the two node-lists differ in count —
> the `Settings→Язык` picker (a fork-added region) sitting next to the timestamp-format seam —
> the alignment slipped and paired the Locale values/endonym with the adjacent seam translations
> (`en:"en" → ru:"24-часовой"`). They _placed_ cleanly, so the landing gates passed; the
> language dropdown rendered a time-format and never applied. Fixed by deleting the 3 entries;
> gate #3 now blocks the class. Slips only occur at fork-added regions, so the PR-translated
> bulk (1:1 node-lists) is unaffected.

**The strict switch:** both gates are strict **iff** `@ru-code/branding` exports
`FAIL_ON_LOCALIZATION_ERROR = true` (read from source via `build/strict.mjs`). Keep it `true`
on the finished fork. It lives in _branding_ — a late patch — on purpose: during an upstream
re-sync the commits replay onto fresh t3, and at intermediate commits the accumulated
dictionary intentionally overshoots the still-partial source. Until branding is applied the
constant is absent ⟹ gates are **lenient** (localize what matches, report the rest, don't
break the build); once branding lands with `= true` the finished tree is **strict**. See the
sync protocol below.
