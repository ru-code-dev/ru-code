// ru-code: exact-match tests for the GIT_SSH_COMMAND builder. Host-key checking is disabled
// (`StrictHostKeyChecking=no`) — release integrity is guaranteed by the signed manifest. Paths are
// single-quoted so spaces, backslashes AND shell metacharacters stay one inert token. No
// passphrase/SSH_ASKPASS options ever appear.

import { describe, expect, it } from "@effect/vitest";

import { buildSshCommand, buildSshEnv } from "../../auto-update/gitAuth/sshCommand.ts";

describe("buildSshCommand", () => {
  it("builds the command with host-key checking disabled", () => {
    expect(buildSshCommand({ keyPath: "/home/me/.ssh/ru_code_update_ed25519" })).toBe(
      `ssh -i '/home/me/.ssh/ru_code_update_ed25519' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no`,
    );
  });

  it("quotes a Windows-style path", () => {
    expect(buildSshCommand({ keyPath: "C:\\Users\\me\\ru_code_update_ed25519" })).toBe(
      `ssh -i 'C:\\Users\\me\\ru_code_update_ed25519' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no`,
    );
  });

  // AU-07. git documents GIT_SSH_COMMAND as SHELL-INTERPRETED, and inside double quotes `sh` still
  // expands `$(…)`, backticks and `$VAR`. The path arrives as an unconstrained wire string and
  // `saveSsh` PERSISTS it, so a hostile path re-executed on every scheduled check, forever, out of
  // any user-visible context. Single quotes make sh expand nothing at all.
  it.each([
    ["/k/$(id)/key", "$(id)"],
    ["/k/`id`/key", "`id`"],
    ["/k/${HOME}/key", "${HOME}"],
    ['/k/"; id; "/key', "; id;"],
    ["/k/$HOME/key", "$HOME"],
  ])("keeps %j inert", (keyPath, _fragment) => {
    const command = buildSshCommand({ keyPath });
    const quoted = command.slice(command.indexOf("-i ") + 3, command.indexOf(" -o"));

    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    expect(quoted.slice(1, -1)).not.toContain("'");
  });

  it("survives a path containing a single quote by escaping it, not by dropping it", () => {
    const command = buildSshCommand({ keyPath: "/k/it's/key" });

    expect(command).toContain(`-i '/k/it'\\''s/key'`);
  });

  it("never emits passphrase / SSH_ASKPASS options", () => {
    const command = buildSshCommand({ keyPath: "/k/id" });
    expect(command).not.toContain("ASKPASS");
    expect(command).not.toContain("passphrase");
  });
});

describe("buildSshEnv", () => {
  it("wraps the command with the non-interactive guard", () => {
    expect(buildSshEnv({ keyPath: "/k/id" })).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: buildSshCommand({ keyPath: "/k/id" }),
    });
  });
});
