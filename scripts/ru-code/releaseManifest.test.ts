// @effect-diagnostics nodeBuiltinImport:off - Tests exercise the release-artifact emission directly.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildChecksumsManifest,
  CHECKSUMS_FILENAME,
  DEFAULT_MIN_NODE,
  deriveMinNode,
  emitReleaseArtifacts,
  signRelease,
  verifyChecksums,
  verifyReleaseSignature,
  writeChecksumsManifest,
  type ChangelogFile,
} from "./releaseManifest.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTemporaryDirectory(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-code-release-manifest-"));
  temporaryDirectories.push(directory);
  return directory;
}

const TARBALL_BYTES = Buffer.from("a fake release tarball payload", "utf8");
const EXPECTED_SHA256 = NodeCrypto.createHash("sha256").update(TARBALL_BYTES).digest("hex");

// Lay out a repo root + output dir with a fixture tarball, a fixture apps/server/package.json (the
// ONLY version source), and a changelog.json. Mirrors the real prepare-release layout.
function makeFixture(options: {
  readonly version: string;
  readonly changelog: ChangelogFile | null;
}): {
  readonly repoRoot: string;
  readonly outputDir: string;
  readonly tarballPath: string;
  readonly tarballFilename: string;
  readonly serverVersion: string;
} {
  const repoRoot = makeTemporaryDirectory();
  const outputDir = NodePath.join(repoRoot, "dist-bundle");
  NodeFS.mkdirSync(outputDir, { recursive: true });

  // Fixture apps/server/package.json — the caller sources the version from here.
  const serverDir = NodePath.join(repoRoot, "apps", "server");
  NodeFS.mkdirSync(serverDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(serverDir, "package.json"),
    JSON.stringify({ name: "t3", version: options.version }, null, 2) + "\n",
  );
  const serverVersion = (
    JSON.parse(NodeFS.readFileSync(NodePath.join(serverDir, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;

  const tarballFilename = `ru-code-${serverVersion}.tgz`;
  const tarballPath = NodePath.join(outputDir, tarballFilename);
  NodeFS.writeFileSync(tarballPath, TARBALL_BYTES);

  if (options.changelog !== null) {
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, "changelog.json"),
      JSON.stringify(options.changelog, null, 2) + "\n",
    );
  }

  return { repoRoot, outputDir, tarballPath, tarballFilename, serverVersion };
}

describe("emitReleaseArtifacts", () => {
  it("emits a v2 manifest with sha256, sizeBytes, filename url, ISO releasedAt, minNode", () => {
    const fixture = makeFixture({
      version: "1.2.3",
      changelog: {
        __doc__: "format",
        "1.2.3": ["shipped it"],
      },
    });

    const result = emitReleaseArtifacts({
      repoRoot: fixture.repoRoot,
      outputDir: fixture.outputDir,
      tarballPath: fixture.tarballPath,
      version: fixture.serverVersion,
      minNode: ">=22",
    });

    // Manifest written to disk matches the returned object.
    const onDisk = JSON.parse(NodeFS.readFileSync(result.manifestPath, "utf8"));
    expect(onDisk).toEqual(result.manifest);

    expect(result.manifest.version).toBe("1.2.3");
    expect(result.manifest.sha256).toBe(EXPECTED_SHA256);
    expect(result.manifest.sizeBytes).toBe(TARBALL_BYTES.byteLength);
    // G25: the manifest carries NO address. The tarball is its sibling and its name comes from the
    // shared `releaseTarballName` convention, so both channels derive it.
    expect(result.manifest).not.toHaveProperty("tarballUrl");
    // releasedAt round-trips through Date -> ISO unchanged.
    // @effect-diagnostics-next-line globalDate:off - test parses an ISO string, no Effect runtime here.
    expect(new Date(result.manifest.releasedAt).toISOString()).toBe(result.manifest.releasedAt);
    expect(result.manifest.minNode).toBe(">=22");
    // v2 dropped rollbackSafe entirely.
    expect(result.manifest).not.toHaveProperty("rollbackSafe");
  });

  it("defaults minNode to DEFAULT_MIN_NODE when the caller passes none", () => {
    const fixture = makeFixture({
      version: "1.0.0",
      changelog: { "1.0.0": ["notes"] },
    });

    const result = emitReleaseArtifacts({
      repoRoot: fixture.repoRoot,
      outputDir: fixture.outputDir,
      tarballPath: fixture.tarballPath,
      version: "1.0.0",
    });

    expect(result.manifest.minNode).toBe(DEFAULT_MIN_NODE);
  });

  it("honors an injected releasedAt", () => {
    const fixture = makeFixture({
      version: "0.9.0",
      changelog: { "0.9.0": ["notes"] },
    });

    const result = emitReleaseArtifacts({
      repoRoot: fixture.repoRoot,
      outputDir: fixture.outputDir,
      tarballPath: fixture.tarballPath,
      version: "0.9.0",
      releasedAt: "2026-07-23T00:00:00.000Z",
    });

    expect(result.manifest.releasedAt).toBe("2026-07-23T00:00:00.000Z");
  });

  it("returns the changelog entry verbatim as notes (no marker stripping in v2)", () => {
    const fixture = makeFixture({
      version: "4.1.0",
      changelog: {
        "4.1.0": ["storage migrated forward", { kind: "feat", text: "new engine" }],
      },
    });

    const result = emitReleaseArtifacts({
      repoRoot: fixture.repoRoot,
      outputDir: fixture.outputDir,
      tarballPath: fixture.tarballPath,
      version: "4.1.0",
    });

    expect(result.notes).toEqual([
      "storage migrated forward",
      { kind: "feat", text: "new engine" },
    ]);
  });

  it("FAILS the gate when the changelog has no entry for the version", () => {
    const fixture = makeFixture({
      version: "2.0.0",
      changelog: {
        __doc__: "format",
        "1.9.0": ["old release only"],
      },
    });

    expect(() =>
      emitReleaseArtifacts({
        repoRoot: fixture.repoRoot,
        outputDir: fixture.outputDir,
        tarballPath: fixture.tarballPath,
        version: "2.0.0",
      }),
    ).toThrow(/no entry for version 2\.0\.0/);
  });

  it("FAILS the gate when changelog.json is missing entirely", () => {
    const fixture = makeFixture({ version: "3.0.0", changelog: null });

    expect(() =>
      emitReleaseArtifacts({
        repoRoot: fixture.repoRoot,
        outputDir: fixture.outputDir,
        tarballPath: fixture.tarballPath,
        version: "3.0.0",
      }),
    ).toThrow(/changelog\.json not found/);
  });

  it("copies changelog.json verbatim into the output directory", () => {
    const fixture = makeFixture({
      version: "5.0.0",
      changelog: {
        __doc__: "format",
        "5.0.0": ["release five"],
      },
    });

    const result = emitReleaseArtifacts({
      repoRoot: fixture.repoRoot,
      outputDir: fixture.outputDir,
      tarballPath: fixture.tarballPath,
      version: "5.0.0",
    });

    expect(NodeFS.existsSync(result.changelogPath)).toBe(true);
    const source = NodeFS.readFileSync(NodePath.join(fixture.repoRoot, "changelog.json"), "utf8");
    const copied = NodeFS.readFileSync(result.changelogPath, "utf8");
    expect(copied).toBe(source);
  });
});

describe("deriveMinNode", () => {
  it("returns the declared engines.node range when present", () => {
    expect(deriveMinNode("^22.16 || >=24.10")).toBe("^22.16 || >=24.10");
    expect(deriveMinNode("  >=20  ")).toBe(">=20");
  });

  it("falls back to DEFAULT_MIN_NODE when engines.node is absent or blank", () => {
    expect(deriveMinNode(undefined)).toBe(DEFAULT_MIN_NODE);
    expect(deriveMinNode(null)).toBe(DEFAULT_MIN_NODE);
    expect(deriveMinNode("   ")).toBe(DEFAULT_MIN_NODE);
  });
});

// Build a small directory tree of real files (nested included) under a fresh temp dir.
function makePayloadTree(): {
  readonly rootDir: string;
  readonly files: ReadonlyArray<{ readonly rel: string; readonly content: string }>;
} {
  const rootDir = makeTemporaryDirectory();
  const files = [
    { rel: "cli.js", content: "// wrapper\n" },
    { rel: "package.json", content: '{"name":"pkg"}\n' },
    { rel: "client/index.html", content: "<html></html>\n" },
    { rel: "node_modules/node-pty/index.js", content: "module.exports = {}\n" },
  ] as const;
  for (const file of files) {
    const absolute = NodePath.join(rootDir, file.rel);
    NodeFS.mkdirSync(NodePath.dirname(absolute), { recursive: true });
    NodeFS.writeFileSync(absolute, file.content);
  }
  return { rootDir, files };
}

describe("buildChecksumsManifest / verifyChecksums", () => {
  it("hashes every file except the checksums file itself", () => {
    const { rootDir, files } = makePayloadTree();
    const manifest = buildChecksumsManifest(rootDir);

    expect(manifest.algo).toBe("sha256");
    // Every source file is present with its real sha256; nothing else.
    expect(Object.keys(manifest.files).sort()).toEqual(files.map((f) => f.rel).sort());
    for (const file of files) {
      const expected = NodeCrypto.createHash("sha256").update(file.content).digest("hex");
      expect(manifest.files[file.rel]).toBe(expected);
    }
  });

  it("excludes an already-present __checksums.json from the map it produces", () => {
    const { rootDir } = makePayloadTree();
    // Pre-seed a stale checksums file at the root — a re-run must not hash it into itself.
    NodeFS.writeFileSync(NodePath.join(rootDir, CHECKSUMS_FILENAME), '{"stale":true}\n');
    const manifest = buildChecksumsManifest(rootDir);
    expect(Object.keys(manifest.files)).not.toContain(CHECKSUMS_FILENAME);
  });

  it("write + verify round-trips green on an untouched tree", () => {
    const { rootDir } = makePayloadTree();
    const written = writeChecksumsManifest(rootDir);

    // The file landed at the tree root and matches the returned manifest.
    const onDisk = JSON.parse(
      NodeFS.readFileSync(NodePath.join(rootDir, CHECKSUMS_FILENAME), "utf8"),
    );
    expect(onDisk).toEqual(written);

    expect(verifyChecksums(rootDir)).toEqual({ ok: true });
  });

  it("catches a MUTATED file", () => {
    const { rootDir } = makePayloadTree();
    writeChecksumsManifest(rootDir);
    // Tamper with one tracked file after the checksums were written.
    NodeFS.writeFileSync(NodePath.join(rootDir, "client/index.html"), "<html>tampered</html>\n");

    const result = verifyChecksums(rootDir);
    expect(result).toEqual({
      ok: false,
      firstMismatch: { path: "client/index.html", reason: "mismatch" },
    });
  });

  it("catches a DELETED file", () => {
    const { rootDir } = makePayloadTree();
    writeChecksumsManifest(rootDir);
    NodeFS.rmSync(NodePath.join(rootDir, "cli.js"));

    const result = verifyChecksums(rootDir);
    expect(result).toEqual({
      ok: false,
      firstMismatch: { path: "cli.js", reason: "missing" },
    });
  });

  it("reports the checksums file itself as missing when absent", () => {
    const { rootDir } = makePayloadTree();
    // No writeChecksumsManifest — nothing to verify against.
    expect(verifyChecksums(rootDir)).toEqual({
      ok: false,
      firstMismatch: { path: CHECKSUMS_FILENAME, reason: "missing" },
    });
  });
});

// ── release signing ─────────────────────────────────────────────────────────────

describe("signRelease / verifyReleaseSignature", () => {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const sha = "a".repeat(64);
  const version = "2.0.0";

  it("round-trips: sign then verify succeeds", () => {
    const sig = signRelease(sha, version, privateKey);
    expect(verifyReleaseSignature(sha, version, sig, publicKey)).toBe(true);
  });

  it("rejects a tampered sha256", () => {
    const sig = signRelease(sha, version, privateKey);
    expect(verifyReleaseSignature("b".repeat(64), version, sig, publicKey)).toBe(false);
  });

  it("rejects a tampered version", () => {
    const sig = signRelease(sha, version, privateKey);
    expect(verifyReleaseSignature(sha, "9.9.9", sig, publicKey)).toBe(false);
  });

  it("rejects a wrong public key", () => {
    const other = NodeCrypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const sig = signRelease(sha, version, privateKey);
    expect(verifyReleaseSignature(sha, version, sig, other.publicKey)).toBe(false);
  });

  it("rejects a corrupted signature", () => {
    const sig = signRelease(sha, version, privateKey);
    const corrupted = sig.slice(0, -4) + "AAAA";
    expect(verifyReleaseSignature(sha, version, corrupted, publicKey)).toBe(false);
  });

  it("emitReleaseArtifacts includes the signature when a key is provided", () => {
    const fixture = makeFixture({ version: "3.0.0", changelog: { "3.0.0": ["signed"] } });
    const keyDir = makeTemporaryDirectory();
    const keyPath = NodePath.join(keyDir, "test-signing.pem");
    NodeFS.writeFileSync(keyPath, privateKey);

    const result = emitReleaseArtifacts({
      repoRoot: fixture.repoRoot,
      outputDir: fixture.outputDir,
      tarballPath: fixture.tarballPath,
      version: "3.0.0",
      signingKeyPath: keyPath,
    });

    expect(typeof result.manifest.signature).toBe("string");
    expect(
      verifyReleaseSignature(
        result.manifest.sha256,
        "3.0.0",
        result.manifest.signature!,
        publicKey,
      ),
    ).toBe(true);
  });

  it("emitReleaseArtifacts omits the signature when no key is provided", () => {
    const fixture = makeFixture({ version: "3.1.0", changelog: { "3.1.0": ["unsigned"] } });

    const result = emitReleaseArtifacts({
      repoRoot: fixture.repoRoot,
      outputDir: fixture.outputDir,
      tarballPath: fixture.tarballPath,
      version: "3.1.0",
    });

    expect(result.manifest.signature).toBeUndefined();
  });
});
