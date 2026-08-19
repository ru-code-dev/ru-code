/**
 * ru-code: raw UTF-8 pathnames in git output. Git's `core.quotePath` defaults
 * to true, so any non-ASCII path (e.g. `привет.md`) comes out of `status`,
 * `diff`, `--numstat` etc. double-quoted and octal-escaped
 * (`"\320\277..."`) — and every parser/consumer downstream then treats the
 * escaped string as the filename: the diff panel shows it, per-file lookups
 * miss the real file, checkpoint file summaries persist it. Disabling
 * quotePath at the two git-invocation funnels makes ALL command output carry
 * real UTF-8 paths. It only affects output encoding — never command behavior.
 *
 * Seams (both one-line, marked `ru-code:`):
 *  - GitVcsDriverCore `executeRaw` (status/diff/review-preview/... commands)
 *  - GitVcsDriver `gitCommand` (checkpoint ops incl. diffCheckpoints)
 *
 * Because the prefix rides EVERY invocation, upstream tests that assert exact
 * argument arrays see it too. `withoutRawUtf8Paths` is the counterpart those
 * assertions call so they keep asserting the subcommand they care about — the
 * port test holds one marked import + one marked call, never a copy of this
 * logic (see the port-test seams below).
 *
 * Test seams (marked `ru-code:`):
 *  - `vcs/GitVcsDriverCore.test.ts` "uses stable diagnostics for every parsed
 *    non-repository command"
 *  - `vcs/GitVcsDriverCore.test.ts` "coalesces concurrent ref pages into one
 *    repository snapshot" (`isRemoteNamesScan`, index-based match on the
 *    spawned command's subcommand)
 *  - `vcs/GitVcsDriverCore.test.ts` "invalidates a ref snapshot when a
 *    mutation fails after changing Git" (the `branch` mutation matcher)
 *  - `vcs/VcsDriverRegistry.test.ts` `normalizeGitArgs`, which strips this
 *    prefix alongside the port's own `-C <cwd>`
 *
 * @module ru-code/vcs/rawUtf8Paths
 */

const GIT_RAW_UTF8_PATH_ARGS = ["-c", "core.quotePath=false"] as const;

/** Prepend the quotePath override; `-c` is a global flag, valid before any subcommand. */
export function withRawUtf8Paths(args: ReadonlyArray<string>): Array<string> {
  return [...GIT_RAW_UTF8_PATH_ARGS, ...args];
}

/**
 * Inverse of {@link withRawUtf8Paths}: drop the prefix if present, leaving the
 * subcommand the caller means to assert on. Returns the input untouched when
 * the prefix is absent, so it is safe on any argument array.
 */
export function withoutRawUtf8Paths(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const [flag, setting] = args;
  return flag === GIT_RAW_UTF8_PATH_ARGS[0] && setting === GIT_RAW_UTF8_PATH_ARGS[1]
    ? args.slice(GIT_RAW_UTF8_PATH_ARGS.length)
    : args;
}
