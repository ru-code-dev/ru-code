// ru-code: pure git-auth classification, URL redaction, env composition, and the web channel's URL
// resolution — the I/O-free bits the check/apply paths depend on.

import { describe, expect, it } from "@effect/vitest";

import { APP_COMMAND, releaseTarballName } from "@ru-code/branding";

import { buildGitEnv, isSshUrl, redactUrl } from "../../auto-update/gitAuth/gitEnv.ts";
import { resolveManifestUrl, resolveTarballUrl } from "../../auto-update/channels/webChannel.ts";

// git stderr classification moved to engine/classification.ts — see classification.test.ts.

describe("redactUrl", () => {
  it("hides embedded credentials", () => {
    expect(redactUrl("https://user:pass@host/team/repo.git")).toBe(
      "https://***@host/team/repo.git",
    );
    expect(redactUrl("https://token@host/repo.git")).toBe("https://***@host/repo.git");
    expect(redactUrl("https://host/repo.git")).toBe("https://host/repo.git");
  });
});

describe("isSshUrl", () => {
  it("recognizes ssh:// and scp-like shorthand, rejects https/file", () => {
    expect(isSshUrl("ssh://git@host/repo.git")).toBe(true);
    expect(isSshUrl("git@github.com:org/repo.git")).toBe(true);
    expect(isSshUrl("https://host/repo.git")).toBe(false);
    expect(isSshUrl("file:///tmp/repo")).toBe(false);
  });
});

describe("buildGitEnv", () => {
  it("applies HTTPS prompt-disabling floor + non-interactive ceiling", () => {
    const env = buildGitEnv({
      repoUrl: "https://host/repo.git",
      authEnv: {},
      baseEnv: { PATH: "/usr/bin", HOME: "/home/u" },
    });
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["GCM_INTERACTIVE"]).toBe("never");
    expect(env["GIT_ASKPASS"]).toBe("false");
    expect(env["SSH_ASKPASS_REQUIRE"]).toBe("never");
    expect(env["GIT_SSH_COMMAND"]).toBeUndefined();
    // ambient env carried through:
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/u");
  });

  it("defaults a BatchMode GIT_SSH_COMMAND for SSH remotes", () => {
    const env = buildGitEnv({ repoUrl: "git@host:org/repo.git", authEnv: {}, baseEnv: {} });
    expect(env["GIT_SSH_COMMAND"]).toBe("ssh -o BatchMode=yes");
  });

  it("lets the caller's real credentials override the floor, but never the ceiling", () => {
    const env = buildGitEnv({
      repoUrl: "https://host/repo.git",
      authEnv: {
        GIT_ASKPASS: "/tmp/askpass.sh", // real credential wins over the 'false' floor
        SSH_ASKPASS_REQUIRE: "force", // passphrase askpass wins over the 'never' floor
        GIT_TERMINAL_PROMPT: "1", // must NOT be able to re-enable prompts
      },
      baseEnv: {},
    });
    expect(env["GIT_ASKPASS"]).toBe("/tmp/askpass.sh");
    expect(env["SSH_ASKPASS_REQUIRE"]).toBe("force");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0"); // ceiling wins
  });

  it("drops undefined ambient values", () => {
    const env = buildGitEnv({
      repoUrl: "https://host/repo.git",
      authEnv: {},
      baseEnv: { DEFINED: "x", MISSING: undefined },
    });
    expect(env["DEFINED"]).toBe("x");
    expect(Object.prototype.hasOwnProperty.call(env, "MISSING")).toBe(false);
  });
});

describe("resolveManifestUrl", () => {
  it("appends manifest.json to a folder and keeps an explicit .json", () => {
    expect(resolveManifestUrl("https://d.example.com/ru-code/stable")).toBe(
      "https://d.example.com/ru-code/stable/manifest.json",
    );
    expect(resolveManifestUrl("https://d.example.com/ru-code/stable/")).toBe(
      "https://d.example.com/ru-code/stable/manifest.json",
    );
    expect(resolveManifestUrl("https://d.example.com/custom.json")).toBe(
      "https://d.example.com/custom.json",
    );
  });
});

// G25: the tarball has no address in the manifest — it is derived from the VERSION and the
// manifest's own directory, using the one convention `prepare-release` also uses.
describe("resolveTarballUrl", () => {
  it("names the manifest's sibling from the release version", () => {
    expect(resolveTarballUrl("https://d.example.com/ru-code/stable", "1.0.0")).toBe(
      `https://d.example.com/ru-code/stable/${releaseTarballName("1.0.0")}`,
    );
  });

  it("resolves against the manifest FILE's directory when the base points at a .json", () => {
    expect(resolveTarballUrl("https://d.example.com/custom.json", "1.0.0")).toBe(
      `https://d.example.com/${releaseTarballName("1.0.0")}`,
    );
  });

  it("tolerates a trailing slash on the configured base", () => {
    expect(resolveTarballUrl("https://d.example.com/stable/", "2.3.4")).toBe(
      `https://d.example.com/stable/${releaseTarballName("2.3.4")}`,
    );
  });

  it("matches what prepare-release writes beside the manifest", () => {
    expect(releaseTarballName("9.9.9")).toBe(`${APP_COMMAND}-9.9.9.tgz`);
  });
});
