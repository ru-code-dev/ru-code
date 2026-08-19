// ru-code: split an inline auth suffix off a custom-model slug (qwen).
//
// The app used to encode a model's auth method INSIDE the slug, as
// `slug(auth-method)` (e.g. `my-model(openai)`), because there was no separate
// auth field. Auth is now its own dropdown, so a slug typed / pasted in the old
// habit must be split: the base becomes the clean slug and the recognised auth
// id pre-selects the dropdown. Leaving it un-split would double-encode at
// dispatch — qwen's setModel wire format is itself `slug(auth)`, so a stored
// `my-model(openai)` would go out as `my-model(openai)(openai)` → 404.
//
// Only a KNOWN auth id is peeled; anything else (a real slug that merely ends in
// parens, or a typo) is left verbatim so we never mangle a legitimate slug.

import { asAuthMethodId, type AuthMethodId } from "@ru-code/branding";

export interface ParsedSlugAuth {
  /** The clean slug, auth suffix removed when one was recognised. */
  readonly slug: string;
  /** Present only when a trailing `(known-auth)` was peeled off. */
  readonly authMethod?: AuthMethodId;
}

// Base (≥1 char, non-greedy) followed by a single trailing `(…)` group whose
// contents hold no parens. Anchored to the end so only a suffix is considered.
const SLUG_AUTH_PATTERN = /^(.+?)\(([^()]+)\)$/;

export function parseSlugWithAuth(raw: string): ParsedSlugAuth {
  const trimmed = raw.trim();
  const match = SLUG_AUTH_PATTERN.exec(trimmed);
  if (!match) {
    return { slug: trimmed };
  }
  const base = match[1]!.trim();
  const authMethod = asAuthMethodId(match[2]!.trim());
  // Unknown auth, or nothing left once the suffix is removed → not an auth
  // suffix at all; keep the original text as the slug.
  if (!authMethod || base.length === 0) {
    return { slug: trimmed };
  }
  return { slug: base, authMethod };
}
