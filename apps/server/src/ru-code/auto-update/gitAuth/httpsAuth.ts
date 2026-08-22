// ru-code: HTTPS git auth as a credentialed URL — the one transport EVERY git version supports.
//
// The previous mechanism handed the credential over as `GIT_CONFIG_COUNT` env config
// (`http.<url>.extraHeader` + an empty `credential.helper`). git only reads those variables since
// 2.31 (March 2021); on an older git — still common on user Windows machines — every variable was
// SILENTLY ignored: no header was sent, the server answered 401, git fell back to prompting and hit
// the GIT_ASKPASS=false floor. The user saw «unable to read askpass response from 'false'» — a
// rejected-credential shape for a credential that was never transmitted, undiagnosable from outside.
// (And the mechanism before THAT — a GIT_ASKPASS `sh` script — needed Git's `sh.exe`, which is not
// on PATH in daemon mode on Windows. Both replacements failed on version/environment gates; the
// URL has no gate.)
//
// Properties, compared to the env-config header:
//   · works on every git ever shipped — no minimum version, no sh/askpass helper, no temp file,
//     one code path per OS;
//   · git uses an embedded credential DIRECTLY and consults no credential.helper, so a stale Git
//     Credential Manager entry can no longer answer first (the property the old
//     `credential.helper=` reset existed for);
//   · both parts are percent-encoded, so no character in a username/password can change the URL's
//     shape (a `:` `@` `/` in a password stays data);
//   · the GIT_ASKPASS/GIT_TERMINAL_PROMPT floor (gitEnv.ts) is unchanged, so a REJECTED credential
//     still fails immediately instead of waiting on a prompt.
//
// The trade-off, stated for the record: the credential now rides argv (`git clone https://u:p@…`)
// and the temp clone's `.git/config` — both readable on the user's OWN machine, for the seconds
// the call runs (the engine always removes the workspace). This is a single-user desktop app
// updating itself; universal compatibility beats hiding the secret from its owner. No log or
// status surface ever sees it — everything the channel reports goes through `redactUrl`.

export interface HttpsCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * Embed the credential into an http(s) repo URL: `https://host/x.git` →
 * `https://user:password@host/x.git`. Userinfo is percent-encoded; any userinfo already present in
 * the URL is replaced (the stored credential is the truth, and a stale `user@` prefix would
 * otherwise win). A URL that is not http(s) — ssh, scp-shorthand, file — passes through untouched:
 * a basic-auth credential has no meaning there.
 */
export const credentialedGitUrl = (params: {
  readonly repoUrl: string;
  readonly credentials: HttpsCredentials;
}): string => {
  const stripped = params.repoUrl.trim().replace(/^(https?:\/\/)[^@/]*@/i, "$1");
  const match = /^(https?:\/\/)(.+)$/i.exec(stripped);
  if (match === null) return params.repoUrl.trim();
  const username = encodeURIComponent(params.credentials.username);
  const password = encodeURIComponent(params.credentials.password);
  return `${match[1]}${username}:${password}@${match[2]}`;
};
