// ru-code: pure builder for GIT_SSH_COMMAND over a passphrase-less ed25519 key FILE. No I/O, no
// passphrase / SSH_ASKPASS path. `-i <path> -o IdentitiesOnly=yes` forces git to use exactly this
// key and nothing from the agent. `-o BatchMode=yes` keeps ssh non-interactive. Host-key checking
// is disabled (`StrictHostKeyChecking=no`) — release integrity is guaranteed by the signed manifest,
// not the transport; this avoids the port/host-key class of failures entirely. The key path is
// quoted so Windows paths with spaces/backslashes are parsed as a single token by git's (bundled sh)
// command splitter.

/**
 * Quote a path for git's GIT_SSH_COMMAND shell splitting (uniform across OSes — Git for Windows
 * parses this with its bundled sh too).
 *
 * SINGLE quotes, not double. Inside double quotes `sh` still expands `$(…)`, backticks and `$VAR`,
 * and git documents GIT_SSH_COMMAND as shell-interpreted — so a key path was a command-execution
 * hole, and a PERSISTED one: `saveSsh` stores the path, so it re-ran on every scheduled check, out
 * of any user-visible context, surviving restarts. Inside single quotes sh expands nothing at all;
 * the only character that needs handling is `'` itself, closed and re-opened around an escaped one.
 */
const quotePath = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export interface SshCommandInput {
  readonly keyPath: string;
}

/** Build the `GIT_SSH_COMMAND` string. */
export const buildSshCommand = (input: SshCommandInput): string => {
  const options = [
    "-i",
    quotePath(input.keyPath),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=no",
  ];
  return `ssh ${options.join(" ")}`;
};

/** The full env for an SSH-authed git invocation: the command plus a non-interactive guard. */
export const buildSshEnv = (input: SshCommandInput): Record<string, string> => ({
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: buildSshCommand(input),
});
