// ru-code: HOW the git source reaches into a release repository — the pure half (no I/O), so every
// selection and classification rule below is unit-testable on strings alone.
//
// Two strategies, in preference order:
//
//   archive — `git archive --remote=<url>` asks the SERVER for named paths and streams them back.
//             No repository is created, nothing is cleaned up afterwards, and the transfer is
//             exactly the bytes asked for. It rides the git wire protocol's `upload-archive`
//             service, which the HTTP protocol does not carry AT ALL and which many servers
//             (GitHub among them) refuse even over ssh.
//
//   clone   — `git clone --filter=blob:none --no-checkout`, then `cat-file` / `checkout` to pull
//             individual blobs on demand. Works everywhere. When the server does not honour the
//             filter it silently transfers everything instead; git says so on stderr and the result
//             is still correct, only fatter — so that is a note in the log, never a failure.
//
// A server that refuses `upload-archive` is NOT a broken source: it is a capability answer. Those
// three rejection texts must never become a `SourceResult` at all — the fall-through to `clone` is
// the whole point, and reporting them would show the user a failure on a source that is about to
// deliver the release perfectly. (They would classify as `transport-other`, which is silent and
// cannot pause anything — so the RULE below is what protects the user here, not the classifier.)

/** The way this process talks to a given release repo. Chosen once, then remembered. */
export type GitStrategy = "archive" | "clone";

/**
 * Can `upload-archive` even be attempted on this URL? It is a git-wire service, so the http(s)
 * transport can never carry it (no capability negotiation exists for it there) — asking would spend
 * a round trip to learn what the scheme already tells us. ssh, the scp-like shorthand and local
 * paths all can, so they are tried and allowed to fall through.
 */
export const archiveIsPossible = (repoUrl: string): boolean =>
  !/^https?:\/\//i.test(repoUrl.trim());

/**
 * The three ways a server says "I do not do upload-archive", verified against real servers:
 *   · `Invalid command: 'git-upload-archive …'`      — GitHub over ssh
 *   · `operation not supported by protocol`          — git's own refusal when the transport can't
 *   · a bare `remote end hung up unexpectedly`       — a server that closes the channel instead of
 *                                                      answering; git reports only the hang-up
 * The last one is deliberately the WEAKEST signal, so it only counts when nothing more specific was
 * said: paired with a real error (auth, missing repo) that text is just noise on the tail of a
 * genuine failure, and treating it as a capability answer would hide the real reason.
 */
export const isArchiveCapabilityRejection = (stderr: string): boolean => {
  const text = stderr.toLowerCase();
  if (/invalid command: '?git-upload-archive/.test(text)) return true;
  if (/operation not supported by protocol/.test(text)) return true;
  if (!/remote end hung up unexpectedly/.test(text)) return false;
  // Only a hang-up, with no other diagnosis in the text.
  return !/(permission denied|authentication failed|access denied|could not read from remote repository|repository not found|does not exist|could not resolve host|connection (refused|reset)|timed out|no route)/.test(
    text,
  );
};

/**
 * A `git archive` that reached the server but was told the PATH is not there. Distinct from a
 * capability rejection: the transport worked, the release layout is wrong (or the branch carries no
 * release yet), and the user must be told — this is exactly the `invalid-manifest` / not-found case.
 */
export const isArchivePathMissing = (stderr: string): boolean =>
  /did not match any files|pathspec/i.test(stderr);

/**
 * Did git tell us the server ignored `--filter`? Then the clone was a FULL transfer (matrix row 4).
 * The outcome is identical, so this only ever reaches the debug log — it explains a slow check.
 */
export const filterWasIgnored = (stderr: string): boolean =>
  /filtering not recognized by server|filter[^\n]*ignored/i.test(stderr);

/** The repo-relative path of a release asset on the release branch. */
export const releaseRepoPath = (releaseDir: string, filename: string): string =>
  releaseDir === "" ? filename : `${releaseDir.replace(/\/+$/, "")}/${filename}`;
