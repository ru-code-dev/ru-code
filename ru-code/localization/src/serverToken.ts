// Wire-crossing display strings — resolved in the VIEWER's locale, not the server's.
//
// A server-emitted display string cannot be resolved at emit time: the server's locale
// is not the viewer's. `Lc(en, ru, ...args)` instead encodes it as a self-contained,
// locale-INDEPENDENT token — an opaque string — that rides the wire / store / projections
// untouched, and is resolved at the display edge by `resolveDeep` in the viewer's locale.
//
// The build transform emits `Lc` (instead of `L`/`LT`) for any dict entry marked
// `"wire": true`. See ../build/vitePlugin.mjs.
//
// SAFETY — this file must NEVER break the app and NEVER mistranslate:
//   1. Non-token strings pass through byte-for-byte (fast reject on the sentinel char).
//   2. A magic tag ("ruc1") means a coincidental sentinel+JSON is never taken for a token.
//   3. `JSON.stringify` escapes U+001E inside the payload, so the sentinel only ever appears
//      as a delimiter — nested tokens and embedded tokens stay unambiguous.
//   4. Every public function is wrapped so on ANY error it returns its input unchanged —
//      it cannot throw. A malformed / foreign token resolves to itself.
//   5. Recursion is depth-capped (no infinite loop / stack overflow).
//   6. Only plain strings/arrays/objects are walked; class instances, Maps, Dates, etc. are
//      returned untouched (never cloned or stripped of their prototype).
//   7. `Lc(en, ru, ...a)` is deterministic, so token identity / `===` / dedup still hold.

import { type Locale, getLocale } from "./locale.ts";

const SENTINEL_CODE = 0x1e; // U+001E RECORD SEPARATOR — never present in normal UI text
const SENTINEL = String.fromCharCode(SENTINEL_CODE);
const MAGIC = "ruc1";
const MAX_DEPTH = 40;

interface TokenPayload {
  readonly t: string; // magic tag
  readonly e: string; // English template
  readonly r: string; // Russian template
  readonly a?: readonly unknown[]; // interpolation args (primitives or nested tokens)
}

/** Encode a wire display string as an opaque, locale-independent token. */
export function Lc(en: string, ru: string, ...args: readonly unknown[]): string {
  const payload: TokenPayload =
    args.length > 0
      ? { t: MAGIC, e: en, r: ru, a: args.map((a) => (a === undefined ? null : a)) }
      : { t: MAGIC, e: en, r: ru };
  return SENTINEL + JSON.stringify(payload) + SENTINEL;
}

/** Cheap structural check: does this value look like one of our tokens? */
export function isToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 2 &&
    value.charCodeAt(0) === SENTINEL_CODE &&
    value.charCodeAt(value.length - 1) === SENTINEL_CODE
  );
}

/** Resolve ONE token string in `locale`. Returns the input unchanged if it is not a valid
 *  ru-code token, or on any error. Never throws. */
export function resolveToken(token: string, locale: Locale, depth = 0): string {
  if (depth > MAX_DEPTH) return token;
  try {
    const payload = JSON.parse(token.slice(1, -1)) as Partial<TokenPayload>;
    if (
      !payload ||
      payload.t !== MAGIC ||
      typeof payload.e !== "string" ||
      typeof payload.r !== "string"
    ) {
      return token; // foreign / malformed — leave exactly as-is
    }
    const template = locale === "en" ? payload.e : payload.r;
    const args = Array.isArray(payload.a) ? payload.a : [];
    return template.replace(/\{(\d+)\}/g, (_match, index: string) => {
      const arg = args[Number(index)];
      if (arg === undefined || arg === null) return "";
      return typeof arg === "string" ? resolveString(arg, locale, depth + 1) : String(arg);
    });
  } catch {
    return token;
  }
}

/** Resolve EVERY token span inside a string (whole-token, embedded, or multiple). Text
 *  between/around tokens is preserved. Non-token strings are returned unchanged. Never throws. */
export function resolveString(value: string, locale: Locale, depth = 0): string {
  if (typeof value !== "string" || value.indexOf(SENTINEL) === -1) return value;
  if (depth > MAX_DEPTH) return value;
  try {
    let out = "";
    let i = 0;
    while (i < value.length) {
      const start = value.indexOf(SENTINEL, i);
      if (start === -1) {
        out += value.slice(i);
        break;
      }
      out += value.slice(i, start);
      const end = value.indexOf(SENTINEL, start + 1);
      if (end === -1) {
        out += value.slice(start); // unterminated sentinel — leave the remainder untouched
        break;
      }
      out += resolveToken(value.slice(start, end + 1), locale, depth);
      i = end + 1;
    }
    return out;
  } catch {
    return value;
  }
}

/**
 * Token-aware display truncation for PERSIST-time limits (e.g. ingestion's 180-char cap on
 * activity summary/detail). Slicing a string that carries a token would cut the token's JSON
 * mid-payload — it could then never resolve and would render raw ON EVERY CLIENT FOREVER
 * (that persisted-truncated-token was the original production leak). Instead:
 *   • plain text (and plain segments around tokens) truncates exactly like the caller's
 *     `slice(0, limit - 3) + "..."` — byte-identical behavior for token-free values;
 *   • a token is NEVER sliced — its interpolation ARGS (the only unbounded part; the e/r
 *     templates are dictionary text, bounded by construction) are truncated instead, keeping
 *     the token valid and the storage bounded;
 *   • nested token args are truncated recursively (depth-capped);
 *   • a foreign / malformed sentinel span is treated as plain text.
 * Never throws — on any error it falls back to the caller's plain truncation.
 */
export function truncateWireSafe(value: string, limit: number, depth = 0): string {
  const cutPlain = (text: string): string =>
    text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
  if (typeof value !== "string" || value.indexOf(SENTINEL) === -1) return cutPlain(value);
  if (depth > MAX_DEPTH) return value;
  try {
    let out = "";
    let i = 0;
    while (i < value.length) {
      const start = value.indexOf(SENTINEL, i);
      if (start === -1) {
        out += cutPlain(value.slice(i));
        break;
      }
      out += cutPlain(value.slice(i, start));
      const end = value.indexOf(SENTINEL, start + 1);
      if (end === -1) {
        out += cutPlain(value.slice(start)); // unterminated sentinel — already not a token
        break;
      }
      out += truncateTokenArgs(value.slice(start, end + 1), limit, depth);
      i = end + 1;
    }
    return out;
  } catch {
    return cutPlain(value);
  }
}

function truncateTokenArgs(token: string, limit: number, depth: number): string {
  try {
    const payload = JSON.parse(token.slice(1, -1)) as Partial<TokenPayload>;
    if (
      !payload ||
      payload.t !== MAGIC ||
      typeof payload.e !== "string" ||
      typeof payload.r !== "string"
    ) {
      // Foreign sentinel span — plain text as far as we are concerned.
      return token.length > limit ? `${token.slice(0, limit - 3)}...` : token;
    }
    if (!Array.isArray(payload.a) || payload.a.length === 0) return token;
    let changed = false;
    const args = payload.a.map((arg) => {
      if (typeof arg !== "string") return arg;
      const truncated = truncateWireSafe(arg, limit, depth + 1);
      if (truncated !== arg) changed = true;
      return truncated;
    });
    if (!changed) return token;
    return SENTINEL + JSON.stringify({ ...payload, a: args }) + SENTINEL;
  } catch {
    // Not parseable ⇒ not our token (ours always parse) — plain text as far as we care.
    return token.length > limit ? `${token.slice(0, limit - 3)}...` : token;
  }
}

/** Cheap, allocation-free deep scan: does any string anywhere inside `value` contain a token
 *  sentinel? Walks the SAME shape `resolveDeep` walks (plain strings / arrays / plain objects;
 *  non-plain objects are skipped) and is depth-capped identically, so `containsToken(v)` is true
 *  exactly when `resolveDeep(v)` would change something. Lets a caller skip cloning token-free
 *  data. Never throws. */
export function containsToken(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  try {
    if (typeof value === "string") return value.indexOf(SENTINEL) !== -1;
    if (Array.isArray(value)) {
      for (const item of value) if (containsToken(item, depth + 1)) return true;
      return false;
    }
    if (value && typeof value === "object") {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false; // not a plain object
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (containsToken((value as Record<string, unknown>)[key], depth + 1)) return true;
      }
      return false;
    }
    return false;
  } catch {
    return false;
  }
}

/** Recursively resolve tokens anywhere inside plain data (strings / arrays / plain objects).
 *  Class instances, Maps, Dates, functions, etc. are returned untouched. Never throws;
 *  depth-capped. Defaults to the current process locale. */
export function resolveDeep<T>(value: T, locale: Locale = getLocale(), depth = 0): T {
  if (depth > MAX_DEPTH) return value;
  try {
    if (typeof value === "string") return resolveString(value, locale, depth) as unknown as T;
    if (Array.isArray(value)) {
      return value.map((item) => resolveDeep(item, locale, depth + 1)) as unknown as T;
    }
    if (value && typeof value === "object") {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return value; // not a plain object
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>)) {
        out[key] = resolveDeep((value as Record<string, unknown>)[key], locale, depth + 1);
      }
      return out as unknown as T;
    }
    return value; // number / boolean / null / undefined / symbol / function
  } catch {
    return value;
  }
}
