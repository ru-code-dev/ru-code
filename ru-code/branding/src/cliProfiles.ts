// ru-code: CLI profile registry — build-time presets layered over the single
// `qwen` provider kind so the app supports qwen custom forks alongside stock qwen.
// Every provider instance carries a profile id; the profile supplies the display
// name, the artifacts id (context-file base) and the bin/dir DEFAULTS. A `null`
// bin/dir default means "use the value preflight detected at boot" (a fork may wire
// or hardcode that detection); a literal is a fixed fallback (stock qwen). Per
// instance, `QwenSettings.binaryPath`/`homePath` override the resolved default.
//
// One kind under the hood (see QWEN_KIND) so models/continuation/checkpoints are
// shared; the profile only changes branding + defaults. See specs/cli-profiles.md.

import { L } from "@ru-code/localization"; // ru-code: hand seam (transform doesn't scan ru-code/). Module-const L is safe: the locale module self-seeds from the server-stamped window.__RU_LOCALE__ at its own init (see locale.ts initialLocale + localeInit.test.ts).

export type CliProfileId = "custom" | "qwen";

// ru-code: qwen's ACP `authenticate` methodId + per-model auth are one of these five
// (the CLI validates methodId against its AuthType enum at `authenticate`, so an
// unknown value hard-fails the session). Ids match qwen's AuthType string values
// (packages/core/src/core/contentGenerator.ts). One source of truth — the profile
// registry, the session-start resolver and the UI dropdown all derive off this.
export const AUTH_METHODS = [
  { id: "openai", label: "OpenAI API" },
  { id: "qwen-oauth", label: "Qwen OAuth" },
  { id: "gemini", label: "Gemini" },
  { id: "vertex-ai", label: "Vertex AI" },
  { id: "anthropic", label: "Anthropic" },
] as const;

export type AuthMethodOption = (typeof AUTH_METHODS)[number];
export type AuthMethodId = AuthMethodOption["id"];

export const AUTH_METHOD_IDS: ReadonlyArray<AuthMethodId> = AUTH_METHODS.map((method) => method.id);

/** Narrow an untrusted string to a known auth-method id (or `undefined`). */
export const asAuthMethodId = (value: string | null | undefined): AuthMethodId | undefined =>
  value != null && (AUTH_METHOD_IDS as readonly string[]).includes(value)
    ? (value as AuthMethodId)
    : undefined;

/** A model advertised by a profile: clean slug + the auth method it dispatches with. */
export interface CliProfileModel {
  /** Sent to qwen as `${slug}(${authMethod})`; stays clean everywhere upstream. */
  readonly slug: string;
  readonly name: string;
  readonly shortName?: string;
  readonly authMethod: AuthMethodId;
  /**
   * Context window in tokens — the meter denominator for this built-in model.
   * Profile-owned by design: discovered/custom models derive theirs from qwen's
   * advertised `contextLimit` / the slug's size suffix instead.
   */
  readonly nTokens: number;
}

export interface CliProfile {
  readonly id: CliProfileId;
  /** Human label for instances of this profile (chat picker, settings, messages). */
  readonly name: string;
  /** Context-file base → `${artifact}.md`; surfaces in error text only. */
  readonly artifact: string;
  /** Default binary; `null` ⇒ use the cli.js preflight detected at boot. */
  readonly binDefault: string | null;
  /** Default CLI home dir; `null` ⇒ use the dir preflight detected at boot. */
  readonly dirDefault: string | null;
  /** One-line description shown on the provider card for this profile. */
  readonly description: string;
  /** Built-in models for this profile (empty ⇒ user adds their own). */
  readonly models: ReadonlyArray<CliProfileModel>;
  /** Session-start auth method + fallback for a custom model with none set. */
  readonly defaultAuthMethod: AuthMethodId;
}

export const CLI_PROFILES = {
  custom: {
    id: "custom",
    name: "Custom Code",
    artifact: "CUSTOM_CODE",
    binDefault: null,
    dirDefault: null,
    description: L(
      "Uses the CLI detected at startup. The path and directory can be overridden below.",
      "Использует CLI, обнаруженный при запуске. Путь и каталог можно переопределить ниже.",
    ),
    models: [
      {
        slug: "qwen/qwen3.6-35b-a3b",
        name: "Qwen3.6",
        shortName: "🐬 Qwen3.6",
        authMethod: "openai",
        nTokens: 252_000,
      },
      {
        slug: "qwen3-coder-flash",
        name: "Qwen3 Coder Flash",
        shortName: "🚀 Flash",
        authMethod: "openai",
        nTokens: 252_000,
      },
    ],
    defaultAuthMethod: "openai",
  },
  qwen: {
    id: "qwen",
    name: "Qwen Code",
    artifact: "QWEN",
    // `qwen` runs as a command on PATH (buildCliSpawn runs a non-.js bin directly);
    // point `binaryPath` at a cli.js or another executable to override.
    binDefault: "qwen",
    dirDefault: "~/.qwen",
    description: L(
      "Standard Qwen Code CLI («qwen», «~/.qwen»). Specify the path to the executable if it is not in PATH.",
      "Стандартный Qwen Code CLI («qwen», «~/.qwen»). Укажите путь до исполняемого файла, если его нет в PATH.",
    ),
    // Stock qwen ships no preconfigured models — the user adds them (each with an
    // auth method) in the provider card. Native auth is Qwen OAuth.
    models: [],
    defaultAuthMethod: "qwen-oauth",
  },
} as const satisfies { readonly [K in CliProfileId]: CliProfile };

export const CLI_PROFILE_IDS = ["custom", "qwen"] as const satisfies readonly CliProfileId[];

/** Profile the boot-seeded built-in instance uses; also the add-provider default. */
export const DEFAULT_CLI_PROFILE_ID: CliProfileId = "custom";

/** Narrow an untrusted id to a known profile, falling back to the default. */
export const resolveCliProfile = (id: string | null | undefined): CliProfile =>
  id != null && id in CLI_PROFILES
    ? CLI_PROFILES[id as CliProfileId]
    : CLI_PROFILES[DEFAULT_CLI_PROFILE_ID];
