// ru-code: pure git-auth helpers — the non-interactive environment and URL redaction. No I/O; used
// by the git channel to keep git from ever hanging on a prompt and to hide embedded credentials from
// logs/status. Failure classification lives in engine/classification.ts (`classifyGitStderr`), which
// reads the git stderr as evidence and maps it to a wire class + code.

import { DISABLE_SSL } from "@ru-code/branding";

/**
 * Whether a repo URL uses SSH transport. Covers both the `ssh://…` scheme and the scp-like
 * shorthand `user@host:path` that git accepts. Everything else (https/http/file) is treated as
 * non-SSH so the HTTPS prompt-disabling defaults apply.
 */
export const isSshUrl = (repoUrl: string): boolean =>
  /^ssh:\/\//i.test(repoUrl) || /^[a-z0-9._-]+@[^/]+:/i.test(repoUrl);

/**
 * The hard ceiling that ALWAYS wins over caller-supplied and ambient env: git may never wait on an
 * interactive terminal prompt or a GUI credential-manager dialog, regardless of what the caller
 * passed. Neither var conflicts with a real credential (a credential.helper still returns stored
 * secrets non-interactively), so forcing them is safe.
 */
const GIT_PROMPT_CEILING: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
};

/**
 * Prompt-disabling defaults that a caller's real credentials may override. For HTTPS we point
 * GIT_ASKPASS at `false` so git can't pop an askpass helper (a configured credential.helper still
 * works, giving ambient success); for SSH we default GIT_SSH_COMMAND to a BatchMode ssh so a
 * key-less probe fails fast instead of hanging. When the caller injects its own ssh command (the
 * credential agents own that), it wins over these floors.
 *
 * HTTPS credentials no longer touch this layer at all: they ride the repo URL itself
 * (httpsAuth.ts `credentialedGitUrl`), so the GIT_ASKPASS floor stays `false` even for an
 * authenticated call — which is what makes a rejected or missing credential fail immediately
 * instead of waiting on a helper.
 *
 * With {@link DISABLE_SSL} the floor also carries `GIT_SSL_NO_VERIFY` — the git-side half
 * of the same environment decision the web channel makes with its own agent. It is a floor, not a
 * ceiling: a caller that deliberately passes its own value still wins. SSH is unaffected either way
 * (it authenticates hosts with known_hosts, not with X.509), so the var only matters over https.
 */
const promptDisablingFloor = (repoUrl: string, disableSsl: boolean): Record<string, string> => {
  const floor: Record<string, string> = {
    GIT_ASKPASS: "false",
    SSH_ASKPASS_REQUIRE: "never",
  };
  if (disableSsl) {
    floor["GIT_SSL_NO_VERIFY"] = "1";
  }
  if (isSshUrl(repoUrl)) {
    floor["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes";
  }
  return floor;
};

/**
 * Compose the environment for a git invocation. Precedence, lowest to highest:
 *   baseEnv (process env: PATH/HOME/…) < prompt-disabling floor < caller auth env < prompt ceiling.
 * The caller's auth env therefore keeps its GIT_ASKPASS / GIT_SSH_COMMAND / SSH_ASKPASS_REQUIRE,
 * while the ceiling guarantees git can never block on a prompt. This module never builds
 * credentials — it only layers the non-interactive guarantees around a caller-supplied auth env.
 */
export const buildGitEnv = (params: {
  readonly repoUrl: string;
  readonly authEnv: Record<string, string>;
  readonly baseEnv: Record<string, string | undefined>;
  /** Certificate verification for git; defaults to the baked {@link DISABLE_SSL}. */
  readonly disableSsl?: boolean;
}): Record<string, string> => {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.baseEnv)) {
    if (typeof value === "string") merged[key] = value;
  }
  Object.assign(
    merged,
    promptDisablingFloor(params.repoUrl, params.disableSsl ?? DISABLE_SSL),
    params.authEnv,
    GIT_PROMPT_CEILING,
  );
  return merged;
};

/**
 * Hide any embedded `user:pass@` (or `user@`) credentials in a URL for logs/status.
 *
 * Parsed rather than pattern-matched. The audit claimed a password containing `/` escapes the old
 * character class; MEASURED, that shape (`https://u:p/w@host/x.git`) is not a URL at all — WHATWG
 * rejects it, because the `/` ends the authority and leaves `p` as a non-numeric port. The only
 * valid way to carry a `/` in a password is percent-encoded, and the old regex already redacted
 * that. So this is not a hole being closed; it is the same guarantee expressed against the parser
 * instead of against a hand-written class, which is what makes it hold for ports, IPv6 literals,
 * `ssh://` and every other valid shape without another pattern to get right.
 *
 * The regex stays as the fallback for what `URL` cannot parse: the scp-like `git@host:path` (which
 * carries no password) and malformed input, where it behaves exactly as it always did.
 */
export const redactUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.username === "" && parsed.password === "") return url;
    parsed.username = "***";
    parsed.password = "";
    // `URL` renders `***@host`; the trailing empty password leaves no colon behind.
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^@/]+@/, "//***@");
  }
};
