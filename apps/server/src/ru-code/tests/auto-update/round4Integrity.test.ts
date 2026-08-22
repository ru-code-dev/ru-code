// ru-code: round 4 — the integrity, classification and journal fixes, each against the real thing
// (a real tree on disk for the checksums walk, a real journal file for the reconcile).
//
// Node's fs/path directly: the fixtures build and mutate trees the way a release tarball extracts,
// and JSON.stringify writes the producer's own manifest shape — the same allowances the module
// under test and the release script carry.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll, describe, expect } from "vite-plus/test";

import { CHECKSUMS_FILENAME, verifyExtractedChecksums } from "../../auto-update/apply/checksums.ts";
import {
  JOURNAL_SCHEMA,
  reconcileJournalAtBoot,
  writeJournal,
} from "../../auto-update/apply/journal.ts";
import { classifyGitStderr } from "../../auto-update/engine/classification.ts";
import { isNewer } from "../../auto-update/manifest.ts";
import { redactUrl } from "../../auto-update/gitAuth/gitEnv.ts";
import { buildChecksumsManifest } from "../../../../../../scripts/ru-code/releaseManifest.ts";

const roots: Array<string> = [];
afterAll(() => {
  for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
});

const tempRoot = (prefix: string): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  roots.push(root);
  return root;
};

// ── AU-32: verification is TWO-WAY ────────────────────────────────────────────────

/** A payload tree shaped like a real release version dir, with its producer-written manifest. */
const makePayload = (): string => {
  const root = tempRoot("ru-au-checksums-");
  NodeFS.mkdirSync(NodePath.join(root, "client"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "cli.js"), "console.log(1)\n");
  NodeFS.writeFileSync(NodePath.join(root, "package.json"), '{"type":"module"}\n');
  NodeFS.writeFileSync(NodePath.join(root, "client", "index.html"), "<!doctype html>\n");
  // Written by the PRODUCER's own builder, so the two sides are proven to enumerate alike rather
  // than merely believed to.
  NodeFS.writeFileSync(
    NodePath.join(root, CHECKSUMS_FILENAME),
    JSON.stringify(buildChecksumsManifest(root), null, 2) + "\n",
  );
  return root;
};

it.layer(NodeServices.layer)("per-file checksum verification", (it) => {
  it.effect("accepts a genuine payload — the two enumerations agree", () =>
    Effect.gen(function* () {
      const verdict = yield* verifyExtractedChecksums(makePayload());
      assert.isTrue(verdict.ok, JSON.stringify(verdict.firstMismatch));
      assert.strictEqual(verdict.checked, 3);
    }),
  );

  it.effect("rejects a MODIFIED file (the direction that always worked)", () =>
    Effect.gen(function* () {
      const root = makePayload();
      NodeFS.writeFileSync(NodePath.join(root, "cli.js"), "console.log(2)\n");
      const verdict = yield* verifyExtractedChecksums(root);
      assert.isFalse(verdict.ok);
      assert.strictEqual(verdict.firstMismatch?.reason, "mismatch");
    }),
  );

  it.effect("rejects a file that is PRESENT but unlisted — the hole this closes", () =>
    Effect.gen(function* () {
      const root = makePayload();
      // The manifest cannot know about this file, so checking only the listed keys passed it
      // unexamined — in the last gate before the pointer flip, on a channel whose shipped URL is
      // plain http with certificate verification off.
      NodeFS.writeFileSync(NodePath.join(root, "client", "payload.js"), "/* added */\n");
      const verdict = yield* verifyExtractedChecksums(root);
      assert.isFalse(verdict.ok);
      assert.strictEqual(verdict.firstMismatch?.reason, "unlisted");
      assert.strictEqual(verdict.firstMismatch?.path, "client/payload.js");
    }),
  );

  it.effect("rejects a DELETED file", () =>
    Effect.gen(function* () {
      const root = makePayload();
      NodeFS.rmSync(NodePath.join(root, "package.json"));
      const verdict = yield* verifyExtractedChecksums(root);
      assert.isFalse(verdict.ok);
      assert.strictEqual(verdict.firstMismatch?.reason, "missing");
    }),
  );
});

// ── AU-15 / #4: a journal that calls the RUNNING version failed is provably wrong ──

it.layer(NodeServices.layer)("boot journal reconcile", (it) => {
  it.effect("rewrites `failed` to `ok` when the target version is the one running", () =>
    Effect.gen(function* () {
      const appRoot = tempRoot("ru-au-journal-");
      // Exactly what `journalPortBusy` leaves behind: the pointer was flipped, the process died
      // before it could hand over, and the user's next launch booted the NEW version anyway.
      yield* writeJournal(appRoot, {
        schema: JOURNAL_SCHEMA,
        targetVersion: "2.0.0",
        fromVersion: "1.0.0",
        outcome: "failed",
        reasonCode: "port-busy",
        at: 1,
      });
      const settled = yield* reconcileJournalAtBoot({
        appRoot,
        currentVersion: "2.0.0",
        now: 2,
      });
      assert.strictEqual(settled?.outcome, "ok");
      assert.strictEqual(settled?.reasonCode, null);
      // …and it is PERSISTED, so /healthz and the settings card stop reporting it after one boot
      // instead of for the life of every process that follows.
      const again = yield* reconcileJournalAtBoot({ appRoot, currentVersion: "2.0.0", now: 3 });
      assert.strictEqual(again?.outcome, "ok");
    }),
  );

  it.effect("leaves a GENUINE failure alone — a different version is running", () =>
    Effect.gen(function* () {
      const appRoot = tempRoot("ru-au-journal-");
      yield* writeJournal(appRoot, {
        schema: JOURNAL_SCHEMA,
        targetVersion: "2.0.0",
        fromVersion: "1.0.0",
        outcome: "failed",
        reasonCode: "spawn-failed",
        at: 1,
      });
      const settled = yield* reconcileJournalAtBoot({
        appRoot,
        currentVersion: "1.0.0",
        now: 2,
      });
      assert.strictEqual(settled?.outcome, "failed");
      assert.strictEqual(settled?.reasonCode, "spawn-failed");
    }),
  );

  it.effect("still settles `started` both ways", () =>
    Effect.gen(function* () {
      const appRoot = tempRoot("ru-au-journal-");
      yield* writeJournal(appRoot, {
        schema: JOURNAL_SCHEMA,
        targetVersion: "2.0.0",
        fromVersion: "1.0.0",
        outcome: "started",
        reasonCode: null,
        at: 1,
      });
      assert.strictEqual(
        (yield* reconcileJournalAtBoot({ appRoot, currentVersion: "1.0.0", now: 2 }))?.reasonCode,
        "not-applied",
      );
    }),
  );
});

// ── AU-39: `403` must mean git said 403, not "the digits appear somewhere" ─────────

describe("classifyGitStderr — the 403 anchor", () => {
  it("still reads a real HTTP 403 as an answered access denial", () => {
    expect(classifyGitStderr("error: The requested URL returned error: 403 Forbidden")).toEqual({
      class: "answered",
      code: "git-access-denied",
    });
  });

  it("does NOT read a sideband object count as an auth denial", () => {
    // git prints these regardless of TTY, and the whole capped stderr is what gets classified.
    // Two answered auth failures PAUSE a source — persisted, zero traffic — and the same result
    // wipes the transport streak that held the real evidence.
    const stderr =
      "remote: Enumerating objects: 403, done.\nfatal: unable to access: Connection timed out";
    expect(classifyGitStderr(stderr)).toEqual({ class: "transport", code: "timeout" });
  });

  it("does not read a port or a byte figure as an auth denial", () => {
    expect(classifyGitStderr("ssh: connect to host h port 403: Connection refused")).toEqual({
      class: "transport",
      code: "refused",
    });
  });
});

// ── AU-48: a prerelease may contain hyphens ───────────────────────────────────────

describe("semver prereleases with hyphens", () => {
  it("orders rc-1 before rc-2 (they used to compare EQUAL)", () => {
    expect(isNewer("1.0.0-rc-2", "1.0.0-rc-1")).toBe(true);
    expect(isNewer("1.0.0-rc-1", "1.0.0-rc-2")).toBe(false);
  });

  it("leaves plain releases exactly as they were", () => {
    expect(isNewer("1.4.2", "1.4.1")).toBe(true);
    expect(isNewer("1.4.1", "1.4.1")).toBe(false);
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
  });
});

// ── AU-53: redaction, expressed against the parser ────────────────────────────────

describe("redactUrl", () => {
  it("hides userinfo in every valid shape", () => {
    expect(redactUrl("https://user:pass@host/repo.git")).toBe("https://***@host/repo.git");
    expect(redactUrl("ssh://git@host:2222/repo.git")).toBe("ssh://***@host:2222/repo.git");
    // Percent-encoded is the only VALID way to carry a `/` in a password.
    expect(redactUrl("https://user:pa%2Fss@host/repo.git")).toBe("https://***@host/repo.git");
  });

  it("leaves credential-free URLs untouched", () => {
    expect(redactUrl("https://host/repo.git")).toBe("https://host/repo.git");
    expect(redactUrl("http://127.0.0.1:8080/dist-bundle/")).toBe(
      "http://127.0.0.1:8080/dist-bundle/",
    );
  });

  it("falls back for the scp-like shorthand URL cannot parse", () => {
    expect(redactUrl("git@github.com:org/repo.git")).toBe("git@github.com:org/repo.git");
  });
});
