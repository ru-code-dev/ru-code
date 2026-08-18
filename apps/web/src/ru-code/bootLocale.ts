// ru-code: seed the UI language as the app's FIRST side effect.
//
// The injected L("en","ru") calls read the module-level current locale at
// EVALUATION time. Strings inside a component's render body re-read it on every
// render (after boot), so they switch. But a module-level `const X = L(...)`
// evaluates once, when its module is imported — and ES modules evaluate every
// import before the importer's own body runs. So seeding the locale from a call
// in main.tsx's body is too late: the whole component tree (and its top-level
// L() constants: composer approve modes, keybinding labels/categories, settings
// nav, timestamp-format labels) has already frozen at the default locale.
//
// Importing THIS module first — before any component module — runs bootLocale()
// as a top-level side effect, so every module-level L() constant evaluates
// against the stored locale. The language toggle reloads the page, which
// re-runs this seed first and re-freezes every constant at the new locale.

import { bootLocale } from "./locale";

bootLocale();
