// ru-code: the ONE grammar for qwen model tokens — `<slug>(<authMethod>)` — shared by
// all three sources that speak it:
//   1. ACP discovery — qwen advertises every model as `formatAcpModelId(id, authType)`
//      = `${id}(${authType})` in the `session/new` / `session/load` response
//      (`acp-integration/acpAgent.ts buildAvailableModels`, qwen-code 0.13.1).
//   2. Backend model errors — the provider API's model-not-found prose (passed
//      verbatim to ACP `data.details`) lists valid models in the same shape.
//   3. User-entered custom models in provider settings.
// The optional trailing size token (`-256k`, `-1m`, case-insensitive) inside the
// slug carries the model's context window; `256K` means 256 000 (decimal, not KiB).
import { isStrippedNameWord } from "@ru-code/branding";

/** One parsed `<slug>(<authMethod>)` token. */
export interface ParsedModelToken {
  /** Clean model id sent back to qwen at setModel (without the auth suffix). */
  readonly slug: string;
  /** Auth method the model dispatches with (`openai`, `qwen-oauth`, ...). */
  readonly authMethod: string;
  /** Context window in tokens parsed from the slug's size suffix; null when absent. */
  readonly nTokens: number | null;
  /** Human-readable label derived from the slug (`Qwen Qwen3.6 Coder 256K`). */
  readonly name: string;
}

// Trailing size token: `-256k` / `_1.5m` at the END of the slug. Decimal
// multipliers (k = 1 000, m = 1 000 000) — model names advertise round decimal
// windows, not binary KiB.
const SIZE_SUFFIX_PATTERN = /[-_](\d+(?:\.\d+)?)([km])$/i;

// A whole trusted token (discovery modelId / settings entry): any non-space,
// non-paren slug followed by a parenthesized auth method. qwen ids may contain
// `/`, `.`, `|` (runtime snapshots), so the slug charset stays permissive here.
const TRUSTED_TOKEN_PATTERN = /^([^\s()]+)\(([^\s()]+)\)$/;

// Token embedded in backend error PROSE. Anchored on the user-confirmed shape
// `xxx/…(…)`: the slug MUST contain a `/` — that plus the adjacent parens is
// distinctive enough to never match ordinary parenthesized words in a sentence.
// The charset is strict (word chars, dot, dash, slash) so trailing punctuation
// like `,` / `.` / quotes never leaks into the slug.
const PROSE_TOKEN_PATTERN = /([A-Za-z0-9._-]+\/[A-Za-z0-9./_-]+)\(([A-Za-z0-9._-]+)\)/g;

/** `256k` → 256 000; `1m` → 1 000 000; null when the slug carries no size token. */
export function parseContextWindowFromSlug(slug: string): number | null {
  const match = SIZE_SUFFIX_PATTERN.exec(slug);
  if (!match?.[1] || !match[2]) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const multiplier = match[2].toLowerCase() === "m" ? 1_000_000 : 1_000;
  return Math.round(amount * multiplier);
}

// A slug fragment that IS a size token (`256k`, `1.5m`) — rendered uppercase.
const SIZE_FRAGMENT_PATTERN = /^\d+(?:\.\d+)?[km]$/i;

// Capitalize a fragment for the UI (`256K` size tokens uppercased, else Title-case).
const renderFragment = (fragment: string): string =>
  SIZE_FRAGMENT_PATTERN.test(fragment)
    ? fragment.toUpperCase()
    : fragment.charAt(0).toUpperCase() + fragment.slice(1);

/**
 * `xxx/yyy-yy_zz-256k` → `Xxx Yyy Yy Zz 256K`: split on `/ - _`, capitalize each
 * fragment's first letter, uppercase size fragments.
 *
 * Fragments listed in STRIP_NAME_WORDS (e.g. a `vllm/` backend prefix) are dropped
 * from the NAME only — the slug the caller holds is untouched. If stripping would
 * leave nothing, the un-stripped fragments are kept so the label is never empty.
 */
export function humanizeModelSlug(slug: string): string {
  const fragments = slug.split(/[/\-_]+/).filter((fragment) => fragment.length > 0);
  const kept = fragments.filter((fragment) => !isStrippedNameWord(fragment));
  return (kept.length > 0 ? kept : fragments).map(renderFragment).join(" ");
}

/**
 * Parse one trusted `<slug>(<authMethod>)` token (discovery modelId or settings
 * entry). Returns null when the token does not match the grammar.
 */
export function parseModelToken(token: string): ParsedModelToken | null {
  const match = TRUSTED_TOKEN_PATTERN.exec(token.trim());
  if (!match?.[1] || !match[2]) return null;
  const slug = match[1];
  return {
    slug,
    authMethod: match[2],
    nTokens: parseContextWindowFromSlug(slug),
    name: humanizeModelSlug(slug),
  };
}

/**
 * Extract every model token embedded in backend error prose. Only
 * slash-qualified slugs match (the `xxx/…(…)` anchor), deduped by slug in
 * first-seen order — whatever sentence the backend wraps them in.
 */
export function extractModelTokens(text: string): ReadonlyArray<ParsedModelToken> {
  const seenSlugs = new Set<string>();
  const tokens: ParsedModelToken[] = [];
  for (const match of text.matchAll(PROSE_TOKEN_PATTERN)) {
    const slug = match[1];
    const authMethod = match[2];
    if (!slug || !authMethod || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    tokens.push({
      slug,
      authMethod,
      nTokens: parseContextWindowFromSlug(slug),
      name: humanizeModelSlug(slug),
    });
  }
  return tokens;
}
