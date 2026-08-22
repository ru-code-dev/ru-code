// ru-code: the v2 persisted auto-update config (engine/configStore.ts). Covers
// the v1 → v2 migration (carries the per-source enabled switches), corrupt/missing
// → fresh defaults, deterministic jitter generated exactly ONCE and persisted
// (via the injected generator), the atomic write, and a full round-trip.
// @effect-diagnostics preferSchemaOverJson:off
// The decode path is exercised against JSON.stringify text on purpose — the
// defensive field decoders are precisely what is under test.

import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  decodeConfig,
  decodeConfigOutcome,
  defaultConfig,
  makeConfigStore,
  type AutoUpdateConfig,
} from "../../auto-update/engine/configStore.ts";

const fixedJitter = () => 17;

describe("decodeConfig — v3 shape", () => {
  it("round-trips a valid v3 config verbatim (jitter kept, no migration)", () => {
    const valid: AutoUpdateConfig = {
      configVersion: 3,
      autoCheck: false,
      jitterMinute: 42,
      sources: {
        git: {
          enabled: false,
          paused: true,
          authFails: 2,
          transportStreak: 5,
          failingSince: 1000,
          lastResult: {
            outcome: "fail",
            at: 999,
            class: "answered",
            code: "git-access-denied",
            latencyMs: 12,
            raw: "denied",
          },
        },
        web: {
          enabled: true,
          paused: false,
          authFails: 0,
          transportStreak: 0,
          failingSince: null,
          lastResult: { outcome: "ok", at: 555, latencyMs: 9, raw: "200 OK" },
        },
      },
      availableRelease: {
        version: "2.0.0",
        releasedAt: 100,
        sizeBytes: 2048,
        sha256: "abc",
        changelog: [{ version: "2.0.0", notes: [{ kind: "feat", text: "new" }] }],
        changelogTruncated: false,
        foundAt: 200,
      },
      notified: { release: { version: "2.0.0", at: 777 }, problems: { at: 888 } },
      notify: { releasesMuted: true, problemsMuted: false },
    };
    const outcome = decodeConfigOutcome(JSON.stringify(valid), fixedJitter);
    expect(outcome.config).toEqual(valid);
    expect(outcome.migrated).toBe(false);
  });

  it("keeps a present in-range jitter and does NOT regenerate", () => {
    expect(
      decodeConfig(JSON.stringify({ configVersion: 3, jitterMinute: 3 }), fixedJitter).jitterMinute,
    ).toBe(3);
  });

  it("generates jitter when absent (via the injected fn) and flags migration", () => {
    const outcome = decodeConfigOutcome(JSON.stringify({ configVersion: 2 }), fixedJitter);
    expect(outcome.config.jitterMinute).toBe(17);
    expect(outcome.migrated).toBe(true);
  });

  it("clamps an out-of-range persisted jitter by regenerating", () => {
    expect(
      decodeConfig(JSON.stringify({ configVersion: 2, jitterMinute: 99 }), fixedJitter)
        .jitterMinute,
    ).toBe(17);
    expect(
      decodeConfig(JSON.stringify({ configVersion: 2, jitterMinute: 12.5 }), fixedJitter)
        .jitterMinute,
    ).toBe(17);
  });

  it("garbage / non-object → fresh defaults, migration flagged", () => {
    for (const text of ["{not json", "", "null", "42", '"str"', "[1,2]"]) {
      const outcome = decodeConfigOutcome(text, fixedJitter);
      expect(outcome.config).toEqual(defaultConfig(17));
      expect(outcome.migrated).toBe(true);
    }
  });

  it("bad per-source fields degrade to source defaults (enabled honored)", () => {
    const decoded = decodeConfig(
      JSON.stringify({
        configVersion: 2,
        jitterMinute: 5,
        sources: {
          git: {
            enabled: false,
            authFails: "x",
            transportStreak: -3,
            failingSince: "no",
            lastResult: { junk: true },
          },
          web: "nope",
        },
      }),
      fixedJitter,
    );
    expect(decoded.sources.git.enabled).toBe(false);
    expect(decoded.sources.git.authFails).toBe(0);
    expect(decoded.sources.git.transportStreak).toBe(0);
    expect(decoded.sources.git.failingSince).toBe(null);
    expect(decoded.sources.git.lastResult).toBe(null);
    expect(decoded.sources.web).toEqual(defaultConfig(5).sources.web);
  });

  it("drops a malformed availableRelease to null", () => {
    expect(
      decodeConfig(
        JSON.stringify({ configVersion: 2, jitterMinute: 1, availableRelease: { version: 5 } }),
        fixedJitter,
      ).availableRelease,
    ).toBe(null);
  });
});

describe("decodeConfig — migrations into v3", () => {
  it("migrates a v1 file, carrying over the per-source enabled switches", () => {
    const v1 = {
      version: 1,
      frequency: "12h",
      installPolicy: "ask",
      web: { enabled: false, url: "https://old/web" },
      git: { enabled: true, url: "https://old/repo.git" },
      lastCheckedAt: 123,
      lastHop: { fromVersion: "1", toVersion: "2", rollbackSafe: true },
    };
    const outcome = decodeConfigOutcome(JSON.stringify(v1), fixedJitter);
    expect(outcome.migrated).toBe(true);
    expect(outcome.config.configVersion).toBe(3);
    expect(outcome.config.autoCheck).toBe(true);
    expect(outcome.config.jitterMinute).toBe(17);
    // enabled switches carried over from the v1 top-level web/git blocks:
    expect(outcome.config.sources.web.enabled).toBe(false);
    expect(outcome.config.sources.git.enabled).toBe(true);
    // retired v1 concepts (frequency/installPolicy/url/lastHop) leave no trace:
    expect(outcome.config.availableRelease).toBe(null);
    expect(outcome.config.notified).toEqual({ release: null, problems: null });
    expect(outcome.config.notify).toEqual({ releasesMuted: false, problemsMuted: false });
  });

  it("a v1 file with both channels disabled carries both disabled", () => {
    const decoded = decodeConfig(
      JSON.stringify({ version: 1, web: { enabled: false }, git: { enabled: false } }),
      fixedJitter,
    );
    expect(decoded.sources.web.enabled).toBe(false);
    expect(decoded.sources.git.enabled).toBe(false);
  });

  // v2 kept ONE number — an explicit «Позже» on whatever release the same file carried. It becomes
  // the v3 release stamp so an upgrade does not re-nag about a version already waved away.
  it("migrates a v2 releaseDismissedAt onto the release it belonged to", () => {
    const v2 = {
      configVersion: 2,
      autoCheck: true,
      jitterMinute: 5,
      sources: { git: { enabled: true }, web: { enabled: true } },
      availableRelease: {
        version: "2.0.0",
        releasedAt: 100,
        sizeBytes: 1,
        sha256: "abc",
        changelog: [],
        changelogTruncated: false,
        foundAt: 200,
      },
      releaseDismissedAt: 777,
      notify: { releasesMuted: false, problemsMuted: true },
    };
    const outcome = decodeConfigOutcome(JSON.stringify(v2), fixedJitter);
    expect(outcome.migrated).toBe(true);
    expect(outcome.config.configVersion).toBe(3);
    expect(outcome.config.notified).toEqual({
      release: { version: "2.0.0", at: 777 },
      problems: null,
    });
    // everything else survives the migration untouched
    expect(outcome.config.jitterMinute).toBe(5);
    expect(outcome.config.notify).toEqual({ releasesMuted: false, problemsMuted: true });
  });

  it("drops a v2 dismissal that has no release to be about", () => {
    const outcome = decodeConfigOutcome(
      JSON.stringify({ configVersion: 2, jitterMinute: 5, releaseDismissedAt: 777 }),
      fixedJitter,
    );
    expect(outcome.config.notified).toEqual({ release: null, problems: null });
  });

  it("ignores a malformed v3 notified block instead of crashing", () => {
    const outcome = decodeConfigOutcome(
      JSON.stringify({
        configVersion: 3,
        jitterMinute: 5,
        notified: { release: { version: 5, at: "soon" }, problems: { at: null } },
      }),
      fixedJitter,
    );
    expect(outcome.config.notified).toEqual({ release: null, problems: null });
  });
});

describe("makeConfigStore", () => {
  it.effect("save → load round-trips through the real filesystem", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "auto-update-config-" });
      const configPath = path.join(root, "state", "auto-update.json");
      const store = yield* makeConfigStore(configPath, fixedJitter);

      const config = defaultConfig(17);
      yield* store.save(config);
      const loaded = yield* store.load;
      assert.deepEqual(loaded, config);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("missing file → fresh defaults (jitter generated)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "auto-update-config-" });
      const store = yield* makeConfigStore(path.join(root, "nope.json"), fixedJitter);
      assert.deepEqual(yield* store.load, defaultConfig(17));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("corrupt file → fresh defaults", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "auto-update-config-" });
      const configPath = path.join(root, "auto-update.json");
      yield* fs.writeFileString(configPath, "{ this is not json");
      const store = yield* makeConfigStore(configPath, fixedJitter);
      assert.deepEqual(yield* store.load, defaultConfig(17));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("jitter is generated ONCE and persisted (a second load never regenerates)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "auto-update-config-" });
      const configPath = path.join(root, "auto-update.json");
      // A v1 file with NO jitter — first load must generate + write it back.
      yield* fs.writeFileString(
        configPath,
        JSON.stringify({ version: 1, git: { enabled: true }, web: { enabled: true } }),
      );

      const firstStore = yield* makeConfigStore(configPath, () => 17);
      const first = yield* firstStore.load;
      assert.equal(first.jitterMinute, 17);

      // The file on disk is now at the CURRENT version, with the generated jitter persisted.
      const onDisk: unknown = JSON.parse(yield* fs.readFileString(configPath));
      assert.equal((onDisk as { configVersion: number }).configVersion, 3);
      assert.equal((onDisk as { jitterMinute: number }).jitterMinute, 17);

      // A fresh store with a DIFFERENT generator loads the persisted value, not a new one.
      const secondStore = yield* makeConfigStore(configPath, () => 42);
      const second = yield* secondStore.load;
      assert.equal(second.jitterMinute, 17);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("the .tmp file is not left behind after a save", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "auto-update-config-" });
      const configPath = path.join(root, "auto-update.json");
      const store = yield* makeConfigStore(configPath, fixedJitter);
      yield* store.save(defaultConfig(17));
      assert.isFalse(yield* fs.exists(`${configPath}.tmp`));
      assert.isTrue(yield* fs.exists(configPath));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("save creates the parent directory when absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "auto-update-config-" });
      const configPath = path.join(root, "deep", "nested", "auto-update.json");
      const store = yield* makeConfigStore(configPath, fixedJitter);
      yield* store.save(defaultConfig(17));
      assert.isTrue(yield* fs.exists(configPath));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // A CURRENT-version file is not migrated on load. The title used to say v2 while the body saved
  // the current shape, and the only assertion was that a round trip preserves the jitter — which a
  // store that rewrote the file on every load would also satisfy. `decodeConfigOutcome` reports
  // `migrated`, so the claim can be made directly.
  it.effect("a current-version file is NOT migrated on load (no rewrite)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "auto-update-config-" });
      const configPath = path.join(root, "auto-update.json");
      const store = yield* makeConfigStore(configPath, fixedJitter);
      const config = defaultConfig(33);
      yield* store.save(config);

      const text = yield* fs.readFileString(configPath);
      assert.isFalse(decodeConfigOutcome(text, () => 99).migrated);

      const loaded = yield* store.load;
      assert.equal(loaded.jitterMinute, 33);
      // …and the bytes on disk are untouched by the load.
      assert.equal(yield* fs.readFileString(configPath), text);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
