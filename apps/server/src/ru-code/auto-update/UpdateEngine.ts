// ru-code: the auto-update engine service — the single authority over update
// state. The ws RPC handlers (rpcHandlers.ts) are a thin veneer over this
// interface; every mutation flows through here so invariants hold in ONE place:
//   · source switches are user-owned — no engine code path flips them
//   · two auth rejections pause a source (persisted, zero traffic); unpause
//     ONLY via a succeeding probeSource / saving tested credentials
//   · install is always the user press; the run is server-owned end to end
//   · links are baked branding constants — there are no URL mutations
// The Live implementation lives in engine/ (state machine + orchestrator).

import type {
  AutoUpdateError,
  AutoUpdateWireState,
  CredentialTestResult,
  GeneratedSshKeyInfo,
  SshKeySourceInput,
  UpdateNotifyKind,
  UpdateSourceKind,
  UserPassCredentialsInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export class UpdateEngine extends Context.Service<
  UpdateEngine,
  {
    /** Current full state snapshot. */
    readonly state: Effect.Effect<AutoUpdateWireState, AutoUpdateError>;
    /** Emits the full state after every change (subscribers prepend a snapshot themselves). */
    readonly changes: Stream.Stream<AutoUpdateWireState, AutoUpdateError>;

    // ── settings ────────────────────────────────────────────────────────────
    readonly setAutoCheck: (
      enabled: boolean,
    ) => Effect.Effect<AutoUpdateWireState, AutoUpdateError>;
    readonly toggleSource: (
      kind: UpdateSourceKind,
      enabled: boolean,
    ) => Effect.Effect<AutoUpdateWireState, AutoUpdateError>;
    readonly setNotifyPrefs: (prefs: {
      readonly releasesMuted: boolean;
      readonly problemsMuted: boolean;
    }) => Effect.Effect<AutoUpdateWireState, AutoUpdateError>;

    // ── credentials (wizard: test-before-save; saves re-test server-side) ────
    readonly testGitHttps: (
      credentials: UserPassCredentialsInput,
    ) => Effect.Effect<CredentialTestResult, AutoUpdateError>;
    readonly saveGitHttps: (
      credentials: UserPassCredentialsInput,
    ) => Effect.Effect<AutoUpdateWireState, AutoUpdateError>;
    readonly generateSshKey: Effect.Effect<GeneratedSshKeyInfo, AutoUpdateError>;
    readonly testSsh: (
      key: SshKeySourceInput,
    ) => Effect.Effect<CredentialTestResult, AutoUpdateError>;
    readonly saveSsh: (
      key: SshKeySourceInput,
    ) => Effect.Effect<AutoUpdateWireState, AutoUpdateError>;
    readonly clearGitCreds: Effect.Effect<AutoUpdateWireState, AutoUpdateError>;
    readonly testWebCreds: (
      credentials: UserPassCredentialsInput,
    ) => Effect.Effect<CredentialTestResult, AutoUpdateError>;
    readonly saveWebCreds: (
      credentials: UserPassCredentialsInput,
    ) => Effect.Effect<AutoUpdateWireState, AutoUpdateError>;
    readonly clearWebCreds: Effect.Effect<AutoUpdateWireState, AutoUpdateError>;

    // ── checks ──────────────────────────────────────────────────────────────
    /** Manual per-card «Проверить» — always allowed; a success unpauses + resets counters. */
    readonly probeSource: (
      kind: UpdateSourceKind,
    ) => Effect.Effect<AutoUpdateWireState, AutoUpdateError>;
    /** A full tick now (git → web, first success wins). No-ops while a run is live. */
    readonly checkNow: Effect.Effect<AutoUpdateWireState, AutoUpdateError>;

    // ── install ─────────────────────────────────────────────────────────────
    /** THE press: download → verify → flip → restart. Try-acquire; second press no-ops. */
    readonly install: Effect.Effect<AutoUpdateWireState, AutoUpdateError>;
    readonly retryRun: Effect.Effect<AutoUpdateWireState, AutoUpdateError>;

    // ── notifications ───────────────────────────────────────────────────────
    /**
     * Stamp a notice as delivered. Sent by a surface the moment it RAISES the notice and by the
     * user waving it away — both mean "be quiet about this until the re-raise window passes".
     */
    readonly snoozeNotification: (
      kind: UpdateNotifyKind,
    ) => Effect.Effect<AutoUpdateWireState, AutoUpdateError>;
  }
>()("t3/ru-code/auto-update/UpdateEngine") {}
