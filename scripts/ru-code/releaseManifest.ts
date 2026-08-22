// @effect-diagnostics nodeBuiltinImport:off - Release-artifact emission runs inside the standalone
// prepare-release script, before any Effect runtime exists.
//
// ru-code: emit the two files the production auto-update feature consumes, next to the release
// tarball, plus the per-file checksums manifest baked INSIDE the tarball:
//
//   manifest.json     (latest-only, schema v2) — { version, sha256, sizeBytes, releasedAt,
//                                                   minNode }
//   changelog.json    (copied verbatim from the repo root) — the release-notes source of truth
//   __checksums.json  (written at the VERSION PAYLOAD root — `package/versions/<v>/`, NOT the
//                                                   archive root — before packing) — per-file
//                                                   sha256 map the install re-verifies after
//                                                   extraction
//
// The auto-update checker fetches manifest.json ONLY, compares its `version` against the installed
// one and (on apply) downloads + verifies the tarball against `sha256`, then re-verifies every
// extracted file against __checksums.json. `changelog.json` is the human-readable notes the UI
// renders. The git release channel commits exactly manifest.json + changelog.json; the tarball
// itself is hosted elsewhere and never committed — this module writes no git, it only emits files.
//
// v2 changes vs the retired W28 shape: `rollbackSafe` (and the __unsafe-rollback__ marker
// mechanism) is GONE — no rollback exists in the pointer/wrapper apply design — and `minNode`
// (the release's required Node range, from apps/server/package.json `engines.node`) is added.
//
// HARD GATE: emitting fails (throws, propagating to a nonzero prepare-release exit) if the repo-root
// changelog.json has no entry for the version being released. Honesty by construction — no release
// without release notes.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Self-describing guidance key in changelog.json. JSON has no comments, so the skeleton carries its
// format description under this key. It is not valid semver, so every parser skips it by design.
export const CHANGELOG_DOC_KEY = "__doc__";

export const CHANGELOG_FILE_NAME = "changelog.json";
export const MANIFEST_FILE_NAME = "manifest.json";

// The per-file checksums manifest, written at the version payload root (`package/versions/<v>/`).
// The install run re-verifies every extracted file against it (§1.6) AND fails on any file the map
// does not list. Its own path is EXCLUDED from the map it contains.
export const CHECKSUMS_FILENAME = "__checksums.json";

// Fallback Node range emitted into the manifest when apps/server/package.json declares no
// `engines.node`. The wrapper's node-version gate reads manifest.minNode.
export const DEFAULT_MIN_NODE = ">=20";

// A single user-visible note: a plain string or a typed entry.
export type ChangelogNote =
  | string
  | { readonly kind: "feat" | "fix" | "perf" | "ui"; readonly text: string };

// A version's raw entry array as stored in changelog.json — the user-visible notes.
export type ChangelogEntry = ReadonlyArray<ChangelogNote>;

export type ChangelogFile = Record<string, unknown>;

export interface ReleaseManifest {
  readonly version: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly releasedAt: string;
  readonly minNode: string;
  readonly signature?: string;
}

// The per-file checksums manifest baked into the version payload root (package/versions/<v>/).
export interface ChecksumsManifest {
  readonly algo: "sha256";
  // Map of tarball-relative POSIX path -> lowercase hex sha256. Excludes CHECKSUMS_FILENAME itself.
  readonly files: Record<string, string>;
}

export type VerifyChecksumsResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly firstMismatch: { readonly path: string; readonly reason: "missing" | "mismatch" };
    };

export interface EmitReleaseArtifactsOptions {
  // Repo root that holds the source-of-truth changelog.json.
  readonly repoRoot: string;
  // Directory the manifest.json + changelog.json are written into (next to the tarball).
  readonly outputDir: string;
  // Path to the tarball the script just produced — hashed and sized for the manifest.
  readonly tarballPath: string;
  // Version being released — the ONLY source is apps/server/package.json (passed by the caller).
  readonly version: string;
  // Required Node range for this release (semver). Defaults to DEFAULT_MIN_NODE; the caller derives
  // it from apps/server/package.json `engines.node` via `deriveMinNode`.
  readonly minNode?: string;
  // ISO emission timestamp. Defaults to now; injectable so tests are deterministic.
  readonly releasedAt?: string;
  // Path to the ed25519 private key for release signing; null/absent → unsigned manifest.
  readonly signingKeyPath?: string | null;
  // Optional logger matching prepare-release's `log`.
  readonly log?: (message: string) => void;
}

export interface EmitReleaseArtifactsResult {
  readonly manifest: ReleaseManifest;
  readonly manifestPath: string;
  readonly changelogPath: string;
  readonly notes: ChangelogEntry;
}

// Read the repo-root changelog.json. Throws a clear English error if it is absent or malformed —
// the release cannot proceed without a parseable notes file.
export function readChangelog(repoRoot: string): ChangelogFile {
  const changelogPath = NodePath.join(repoRoot, CHANGELOG_FILE_NAME);
  if (!NodeFS.existsSync(changelogPath)) {
    throw new Error(
      `Release gate: ${CHANGELOG_FILE_NAME} not found at ${changelogPath}. Every release must ship release notes — create ${CHANGELOG_FILE_NAME} at the repo root with an entry for this version.`,
    );
  }
  const raw = NodeFS.readFileSync(changelogPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Release gate: ${changelogPath} is not valid JSON`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Release gate: ${changelogPath} must be a JSON object keyed by semver version.`,
    );
  }
  return parsed as ChangelogFile;
}

// HARD GATE: resolve the entry array for `version`, or throw. No entry -> no release.
export function resolveChangelogEntry(changelog: ChangelogFile, version: string): ChangelogEntry {
  const entry = changelog[version];
  if (!Array.isArray(entry)) {
    throw new Error(
      `Release gate: ${CHANGELOG_FILE_NAME} has no entry for version ${version}. Every release must ship release notes — add a "${version}" array of notes before running prepare-release.`,
    );
  }
  return entry as ChangelogEntry;
}

// Resolve the release's required Node range from apps/server/package.json `engines.node`, falling
// back to DEFAULT_MIN_NODE when that field is absent/blank.
export function deriveMinNode(enginesNode: string | undefined | null): string {
  return typeof enginesNode === "string" && enginesNode.trim() !== ""
    ? enginesNode.trim()
    : DEFAULT_MIN_NODE;
}

// Hash + size the actual tarball the script produced. STREAMED through `hashFileSha256` — the same
// helper, and for the same reason, as every in-tarball file: `readFileSync` pulled the whole 34 MB
// artifact into memory to hash it, three lines above a function whose comment says a large file
// must never load whole.
export function computeTarballDigest(tarballPath: string): {
  readonly sha256: string;
  readonly sizeBytes: number;
} {
  return {
    sha256: hashFileSha256(tarballPath),
    sizeBytes: NodeFS.statSync(tarballPath).size,
  };
}

export interface BuildManifestInput {
  readonly version: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly releasedAt: string;
  readonly minNode: string;
}

export function buildManifest(input: BuildManifestInput): ReleaseManifest {
  return {
    version: input.version,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    releasedAt: input.releasedAt,
    minNode: input.minNode,
  };
}

export function signRelease(sha256: string, version: string, privateKeyPem: string): string {
  const data = Buffer.from(`${sha256}|${version}`, "utf8");
  return NodeCrypto.sign(null, data, privateKeyPem).toString("base64");
}

export function verifyReleaseSignature(
  sha256: string,
  version: string,
  signature: string,
  publicKeyPem: string,
): boolean {
  const data = Buffer.from(`${sha256}|${version}`, "utf8");
  return NodeCrypto.verify(null, data, publicKeyPem, Buffer.from(signature, "base64"));
}

// ── per-file checksums (baked into the tarball root) ──────────────────────────────

// Chunked ("streaming") sha256 of a single file: read into a fixed 1 MiB buffer via a file
// descriptor and update the hash incrementally, so a large in-tarball file never loads whole into
// memory. Stays synchronous to fit prepare-release's sync flow.
const HASH_CHUNK_BYTES = 1 << 20; // 1 MiB

function hashFileSha256(filePath: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const fd = NodeFS.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const bytesRead = NodeFS.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    NodeFS.closeSync(fd);
  }
  return hash.digest("hex");
}

// Every file under `rootDir` as a sorted list of POSIX-relative paths, EXCLUDING the checksums file
// itself. Sorted so `verifyChecksums`'s "firstMismatch" is deterministic across platforms.
function listFilesRecursive(rootDir: string): ReadonlyArray<string> {
  const found: string[] = [];
  const walk = (absoluteDir: string, relativeDir: string): void => {
    for (const entry of NodeFS.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      const absolutePath = NodePath.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        if (relativePath === CHECKSUMS_FILENAME) continue; // never checksum the checksums file itself
        found.push(relativePath);
      }
    }
  };
  walk(rootDir, "");
  return found.sort();
}

// Build the per-file checksums manifest for every file under `rootDir` (except CHECKSUMS_FILENAME).
export function buildChecksumsManifest(rootDir: string): ChecksumsManifest {
  const files: Record<string, string> = {};
  for (const relativePath of listFilesRecursive(rootDir)) {
    files[relativePath] = hashFileSha256(NodePath.join(rootDir, relativePath));
  }
  return { algo: "sha256", files };
}

// Build the checksums manifest for `rootDir` and write it to `<rootDir>/__checksums.json`. Called
// from prepare-release's seam AFTER the payload is fully staged and BEFORE the tarball is packed, so
// the tarball carries its own integrity map. Returns the manifest that was written.
export function writeChecksumsManifest(rootDir: string): ChecksumsManifest {
  const manifest = buildChecksumsManifest(rootDir);
  NodeFS.writeFileSync(
    NodePath.join(rootDir, CHECKSUMS_FILENAME),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}

// Verify every file recorded in `<rootDir>/__checksums.json` against the file on disk. Returns the
// FIRST mismatch (deterministic order): a recorded file that is gone -> "missing"; a recorded file
// whose current sha256 differs -> "mismatch". Returns { ok: true } only when all recorded files
// match. A missing/unparseable checksums file is itself a "missing" mismatch on CHECKSUMS_FILENAME.
export function verifyChecksums(rootDir: string): VerifyChecksumsResult {
  const checksumsPath = NodePath.join(rootDir, CHECKSUMS_FILENAME);
  if (!NodeFS.existsSync(checksumsPath)) {
    return { ok: false, firstMismatch: { path: CHECKSUMS_FILENAME, reason: "missing" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(NodeFS.readFileSync(checksumsPath, "utf8"));
  } catch {
    return { ok: false, firstMismatch: { path: CHECKSUMS_FILENAME, reason: "mismatch" } };
  }
  const files = (parsed as Partial<ChecksumsManifest> | null)?.files;
  if (typeof files !== "object" || files === null) {
    return { ok: false, firstMismatch: { path: CHECKSUMS_FILENAME, reason: "mismatch" } };
  }
  for (const relativePath of Object.keys(files).sort()) {
    const expected = files[relativePath];
    const absolutePath = NodePath.join(rootDir, relativePath);
    if (!NodeFS.existsSync(absolutePath)) {
      return { ok: false, firstMismatch: { path: relativePath, reason: "missing" } };
    }
    if (hashFileSha256(absolutePath) !== expected) {
      return { ok: false, firstMismatch: { path: relativePath, reason: "mismatch" } };
    }
  }
  return { ok: true };
}

// Orchestrator called from prepare-release's tiny seam. Runs the changelog gate, computes the
// digest, writes manifest.json, and copies changelog.json into the output directory.
export function emitReleaseArtifacts(
  options: EmitReleaseArtifactsOptions,
): EmitReleaseArtifactsResult {
  const log = options.log ?? (() => {});

  // 1. HARD GATE: the version must have a changelog entry.
  const changelog = readChangelog(options.repoRoot);
  const entry = resolveChangelogEntry(changelog, options.version);

  // 2. Derive manifest fields from the real tarball.
  const { sha256, sizeBytes } = computeTarballDigest(options.tarballPath);
  // @effect-diagnostics-next-line globalDate:off - standalone release script, no Effect runtime/DateTime here.
  const releasedAt = options.releasedAt ?? new Date().toISOString();
  const minNode = options.minNode ?? DEFAULT_MIN_NODE;
  const manifest: ReleaseManifest = {
    ...buildManifest({
      version: options.version,
      sha256,
      sizeBytes,
      releasedAt,
      minNode,
    }),
    ...(options.signingKeyPath
      ? {
          signature: signRelease(
            sha256,
            options.version,
            NodeFS.readFileSync(options.signingKeyPath, "utf8"),
          ),
        }
      : {}),
  };

  // 3. Write manifest.json next to the tarball.
  NodeFS.mkdirSync(options.outputDir, { recursive: true });
  const manifestPath = NodePath.join(options.outputDir, MANIFEST_FILE_NAME);
  NodeFS.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // 4. Copy changelog.json verbatim into the output — the git channel commits exactly these two.
  const changelogPath = NodePath.join(options.outputDir, CHANGELOG_FILE_NAME);
  NodeFS.copyFileSync(NodePath.join(options.repoRoot, CHANGELOG_FILE_NAME), changelogPath);

  log(
    `wrote ${MANIFEST_FILE_NAME} (sha256 ${sha256.slice(0, 12)}…, ${sizeBytes} bytes, minNode=${minNode}) + copied ${CHANGELOG_FILE_NAME}`,
  );

  return { manifest, manifestPath, changelogPath, notes: entry };
}
