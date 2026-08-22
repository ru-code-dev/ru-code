// ru-code: the PLAINTEXT credential model that lives only inside the encrypted file, plus its
// defensive codec. The whole model is one JSON object encrypted as a single blob; it never crosses
// the wire (only the redacted presence does). Decode is total: any malformed byte stream, wrong
// shape, or bad branch degrades to "absent" (null) — a corrupt file must never crash a read.
// @effect-diagnostics preferSchemaOverJson:off

/** How the SSH key file came to exist. `file` = a pre-existing key the user pointed us at. */
export type SshKeyOrigin = "paste" | "generate" | "file";

/** HTTPS git over a self-hosted server: USERNAME + PASSWORD (not a token). */
export interface StoredHttpsCredential {
  readonly username: string;
  readonly password: string;
  /** Epoch milliseconds. */
  readonly savedAt: number;
}

/** SSH git via a passphrase-less ed25519 key FILE on disk. */
export interface StoredSshCredential {
  readonly path: string;
  readonly origin: SshKeyOrigin;
  readonly fingerprint: string;
  readonly keyType: "ed25519";
  /** Epoch milliseconds. */
  readonly savedAt: number;
}

/** The full stored model. Every branch may be absent. `web` = optional basic-auth for the web source. */
export interface StoredCredentials {
  readonly https: StoredHttpsCredential | null;
  readonly ssh: StoredSshCredential | null;
  /** Web source basic-auth (username/password). Additive: a pre-web file decodes it as null. */
  readonly web: StoredHttpsCredential | null;
}

/** The empty model — returned whenever nothing is stored or the file is unreadable/corrupt. */
export const EMPTY_CREDENTIALS: StoredCredentials = { https: null, ssh: null, web: null };

const SSH_ORIGINS: ReadonlySet<string> = new Set<SshKeyOrigin>(["paste", "generate", "file"]);

export const encodeCredentials = (value: StoredCredentials): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;

const decodeHttps = (value: unknown): StoredHttpsCredential | null => {
  const record = asRecord(value);
  if (record === null) return null;
  if (
    typeof record["username"] !== "string" ||
    typeof record["password"] !== "string" ||
    typeof record["savedAt"] !== "number"
  ) {
    return null;
  }
  return { username: record["username"], password: record["password"], savedAt: record["savedAt"] };
};

const decodeSsh = (value: unknown): StoredSshCredential | null => {
  const record = asRecord(value);
  if (record === null) return null;
  const origin = record["origin"];
  if (
    typeof record["path"] !== "string" ||
    typeof record["fingerprint"] !== "string" ||
    typeof origin !== "string" ||
    !SSH_ORIGINS.has(origin) ||
    record["keyType"] !== "ed25519" ||
    typeof record["savedAt"] !== "number"
  ) {
    return null;
  }
  return {
    path: record["path"],
    origin: origin as SshKeyOrigin,
    fingerprint: record["fingerprint"],
    keyType: "ed25519",
    savedAt: record["savedAt"],
  };
};

/** Total decode: bad bytes / wrong shape / bad branch → that branch (or the whole model) is absent. */
export const decodeCredentials = (bytes: Uint8Array): StoredCredentials => {
  const record = asRecord(parseJson(bytes));
  if (record === null) return EMPTY_CREDENTIALS;
  return {
    https: decodeHttps(record["https"]),
    ssh: decodeSsh(record["ssh"]),
    // Additive backcompat: a file written before the web slot existed has no `web` key → null.
    web: decodeHttps(record["web"]),
  };
};
