// ru-code: the git strategy rules — pure, so every one of them is checked on strings alone.
//
// The load-bearing rule is the capability one. A server that refuses `upload-archive` has ANSWERED,
// and answering wrongly twice PAUSES a source (transitions.ts, INV-2). So if a capability rejection
// ever reached `applySourceResult`, a healthy release repo would take itself offline the second time
// it was checked, and the user would be told to fix credentials that are perfectly fine.

import { describe, expect, it } from "@effect/vitest";

import {
  archiveIsPossible,
  filterWasIgnored,
  isArchiveCapabilityRejection,
  isArchivePathMissing,
  releaseRepoPath,
} from "../../auto-update/channels/gitStrategy.ts";

describe("archiveIsPossible", () => {
  it("is false for http(s) — the protocol cannot carry upload-archive at all", () => {
    expect(archiveIsPossible("https://git.example.com/team/rel.git")).toBe(false);
    expect(archiveIsPossible("http://git.example.com/team/rel.git")).toBe(false);
    expect(archiveIsPossible("  HTTPS://git.example.com/team/rel.git  ")).toBe(false);
  });

  it("is true for ssh, the scp shorthand and local paths", () => {
    expect(archiveIsPossible("ssh://git@host/team/rel.git")).toBe(true);
    expect(archiveIsPossible("git@host:team/rel.git")).toBe(true);
    expect(archiveIsPossible("/srv/git/rel.git")).toBe(true);
    expect(archiveIsPossible("file:///srv/git/rel.git")).toBe(true);
  });
});

describe("isArchiveCapabilityRejection", () => {
  it("recognises GitHub's refusal over ssh", () => {
    expect(
      isArchiveCapabilityRejection(
        "Invalid command: 'git-upload-archive 'org/repo.git''\n" +
          "  You appear to have cloned an empty repository.\n" +
          "fatal: The remote end hung up unexpectedly",
      ),
    ).toBe(true);
  });

  it("recognises git's own protocol refusal", () => {
    expect(isArchiveCapabilityRejection("fatal: operation not supported by protocol")).toBe(true);
  });

  it("recognises a bare hang-up — a server that closes instead of answering", () => {
    expect(isArchiveCapabilityRejection("fatal: the remote end hung up unexpectedly")).toBe(true);
  });

  it("does NOT swallow a hang-up that came with a real diagnosis", () => {
    // These are genuine failures the user must see. Reading them as "no upload-archive here" would
    // silently retry with a clone that fails the same way, and report the clone's error instead.
    for (const stderr of [
      "git@host: Permission denied (publickey).\nfatal: Could not read from remote repository.\nfatal: the remote end hung up unexpectedly",
      "remote: Repository not found.\nfatal: the remote end hung up unexpectedly",
      "ssh: Could not resolve hostname host: Name or service not known\nfatal: the remote end hung up unexpectedly",
      "ssh: connect to host host port 22: Connection refused\nfatal: the remote end hung up unexpectedly",
    ]) {
      expect(isArchiveCapabilityRejection(stderr)).toBe(false);
    }
  });

  it("does NOT treat an ordinary failure as a capability answer", () => {
    expect(isArchiveCapabilityRejection("fatal: Authentication failed")).toBe(false);
    expect(isArchiveCapabilityRejection("")).toBe(false);
  });
});

describe("isArchivePathMissing", () => {
  it("recognises the server's pathspec rejection", () => {
    expect(
      isArchivePathMissing(
        "remote: fatal: pathspec 'dist-bundle/manifest.json' did not match any files",
      ),
    ).toBe(true);
  });

  it("is distinct from a capability answer — the transport WORKED, the layout is wrong", () => {
    const stderr = "remote: fatal: pathspec 'dist-bundle/manifest.json' did not match any files";
    expect(isArchivePathMissing(stderr)).toBe(true);
    expect(isArchiveCapabilityRejection(stderr)).toBe(false);
  });
});

describe("filterWasIgnored", () => {
  it("recognises both wordings git uses", () => {
    expect(filterWasIgnored("warning: filtering not recognized by server, ignoring")).toBe(true);
    expect(
      filterWasIgnored("warning: --filter is ignored in local clones; use file:// instead."),
    ).toBe(true);
  });

  it("is quiet on a normal clone", () => {
    expect(filterWasIgnored("Cloning into 'checkout'...\ndone.")).toBe(false);
  });
});

describe("releaseRepoPath", () => {
  it("joins the release dir and the filename, tolerating a trailing slash", () => {
    expect(releaseRepoPath("dist-bundle", "manifest.json")).toBe("dist-bundle/manifest.json");
    expect(releaseRepoPath("dist-bundle/", "manifest.json")).toBe("dist-bundle/manifest.json");
  });

  it("supports a release published at the repo root", () => {
    expect(releaseRepoPath("", "manifest.json")).toBe("manifest.json");
  });
});
