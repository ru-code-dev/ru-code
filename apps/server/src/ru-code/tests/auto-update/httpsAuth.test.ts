// ru-code: HTTPS git auth as a credentialed URL. These tests pin the properties the URL carrier
// must provide: works for any git version (nothing env-config here to be ignored), percent-encoding
// keeps every password character data, stale userinfo in a configured URL never wins over the
// stored credential, non-http URLs are untouched, and no log surface can see the secret
// (`redactUrl` hides exactly what `credentialedGitUrl` embeds).

import { describe, expect, it } from "vite-plus/test";

import { buildGitEnv, redactUrl } from "../../auto-update/gitAuth/gitEnv.ts";
import { credentialedGitUrl } from "../../auto-update/gitAuth/httpsAuth.ts";

const REPO = "https://git.example.com/org/release.git";

const urlFor = (credentials: { username: string; password: string }, repoUrl = REPO) =>
  credentialedGitUrl({ repoUrl, credentials });

describe("credentialedGitUrl", () => {
  it("embeds the credential as percent-encoded userinfo", () => {
    expect(urlFor({ username: "u", password: "p" })).toBe(
      "https://u:p@git.example.com/org/release.git",
    );
  });

  // The reason this works on every git: the credential is part of the URL itself, the transport
  // git has supported forever — not config that git 2.31+ happens to read from the environment.
  it("keeps every reserved character data — nothing in a password can change the URL shape", () => {
    const url = urlFor({ username: "user@corp", password: "p@:s/s?#[]" });
    expect(url).toBe(
      "https://user%40corp:p%40%3As%2Fs%3F%23%5B%5D@git.example.com/org/release.git",
    );
    // …and the parsed URL round-trips to exactly the raw secret.
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.username)).toBe("user@corp");
    expect(decodeURIComponent(parsed.password)).toBe("p@:s/s?#[]");
  });

  // The stored credential is the truth. A URL configured with a stale `someone@` prefix would
  // otherwise beat the credential the user just saved — the failure would look like a rejected
  // password on a credential that was never sent.
  it("replaces any userinfo already present in the configured URL", () => {
    expect(urlFor({ username: "u", password: "p" }, "https://someone@git.example.com/x.git")).toBe(
      "https://u:p@git.example.com/x.git",
    );
    expect(
      urlFor({ username: "u", password: "p" }, "https://someone:old@git.example.com/x.git"),
    ).toBe("https://u:p@git.example.com/x.git");
  });

  // `@` inside the path is not userinfo — only a prefix before the first slash is.
  it("does not mistake an at-sign later in the URL for userinfo", () => {
    expect(
      urlFor({ username: "u", password: "p" }, "https://git.example.com/org/re@lease.git"),
    ).toBe("https://u:p@git.example.com/org/re@lease.git");
  });

  it("trims stray whitespace around the configured URL", () => {
    expect(urlFor({ username: "u", password: "p" }, `  ${REPO}  `)).toBe(
      "https://u:p@git.example.com/org/release.git",
    );
  });

  // A basic-auth credential has no meaning on ssh/scp/file transports — embedding it there would
  // corrupt a working URL. The ssh key path is a different agent entirely (sshCommand.ts).
  it("passes non-http(s) URLs through untouched", () => {
    for (const url of [
      "git@host:team/rel.git",
      "ssh://git@host/team/rel.git",
      "file:///srv/release.git",
      "",
    ]) {
      expect(urlFor({ username: "u", password: "p" }, url)).toBe(url.trim());
    }
  });

  // The property that keeps the secret off every log/status surface: redactUrl (which every
  // channel failure and log line goes through) hides exactly what this function embeds.
  it("redactUrl masks the embedded credential completely", () => {
    const url = urlFor({ username: "release-bot", password: "s3cret:with$punct" });
    const redacted = redactUrl(url);
    expect(redacted).not.toContain("s3cret");
    expect(redacted).not.toContain("release-bot");
    expect(redacted).toContain("***");
    expect(redacted).toContain("git.example.com");
  });
});

describe("the composed git environment", () => {
  // The credential rides the URL, so the env for an authenticated https call is EMPTY auth over
  // the floor — and the floor is what guarantees a rejected credential errors instead of hanging.
  it("keeps the non-interactive floor for a credentialed call", () => {
    const env = buildGitEnv({
      repoUrl: urlFor({ username: "u", password: "p" }),
      authEnv: {},
      baseEnv: { PATH: "/usr/bin" },
      disableSsl: false,
    });

    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["GCM_INTERACTIVE"]).toBe("never");
    // The floor's askpass block stays: with no helper and no prompt, a REJECTED credential fails
    // fast — the embedded URL is the one and only attempt.
    expect(env["GIT_ASKPASS"]).toBe("false");
  });

  it("no GIT_CONFIG_* env config is emitted anywhere — nothing left for an old git to ignore", () => {
    const env = buildGitEnv({
      repoUrl: urlFor({ username: "u", password: "s3cret" }),
      authEnv: {},
      baseEnv: {},
      disableSsl: false,
    });
    expect(Object.keys(env).filter((key) => key.startsWith("GIT_CONFIG"))).toEqual([]);
    // …and the environment never carries the secret at all (it is in the URL, not the env).
    expect(Object.values(env).some((value) => value.includes("s3cret"))).toBe(false);
  });
});
