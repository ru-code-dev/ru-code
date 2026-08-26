// ru-code: per-turn MCP overlay choreography for the provider-command reactor — keeps the
// upstream seam to one-line calls. A turn RESOLVES the overlay in memory (the fingerprint
// drives the respawn diff); the FILE is written only by an actual spawn with ≥1 enabled
// server. Reuse turns and 0-server spawns write nothing: qwen without an overlay behaves
// byte-identically (folder trust is off by default in qwen 0.13.1 and an empty allowlist
// already omits the CLI_ARGS.ALLOWED_MCP_SERVERS flag (branding cliEnv.ts) — verified against
// qwen source), so the empty overlay was pure dead weight. The written file is deleted the
// moment the spawn-decision region settles (`withCleanup`).

import {
  type McpOverlaySpawnReason,
  type McpSessionOverlayShape,
  type OverlayResolution,
} from "@smart-tools/qwen-cli-mcp-manager/server";
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** How the spawn came to be — refined into the per-cause `spawnReason` of the overlay logs. */
export type McpOverlaySpawnKind = "fresh-spawn" | "respawn";

/** The overlay fields an actual spawn spreads into `startSession` (empty ⇒ no-MCP spawn). */
export type McpSpawnOverlayFields =
  | { readonly settingsOverlayPath: string; readonly allowedMcpServers: ReadonlyArray<string> }
  | Record<string, never>;

export interface McpTurnOverlay {
  /** Current overlay fingerprint (undefined ⇒ engine off / resolution failed). */
  readonly fingerprint: string | undefined;
  /** Does the live session's spawn-time overlay differ from the current one? */
  readonly overlayChanged: Effect.Effect<boolean>;
  /**
   * Write the overlay file for an ACTUAL spawn and return the `startSession` fields.
   * 0 enabled servers ⇒ nothing written, empty fields (a clean no-MCP spawn). The
   * written path is kept for `withCleanup`.
   */
  readonly overlayFieldsForSpawn: (
    kind: McpOverlaySpawnKind,
  ) => Effect.Effect<McpSpawnOverlayFields>;
  /** Record what this (re)spawn was based on, for the next turn's diff. */
  readonly recordSpawn: Effect.Effect<void>;
  /** Debug trace for a reuse turn: session live, nothing spawned, nothing written. */
  readonly logReuseSkip: Effect.Effect<void>;
  /** Delete the ephemeral overlay file (if one was written) when the region settles. */
  readonly withCleanup: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export const makeMcpTurnOverlay = (input: {
  readonly mcpSessionOverlay: McpSessionOverlayShape;
  readonly projectId: ProjectId;
  readonly threadId: string;
}): Effect.Effect<McpTurnOverlay> =>
  Effect.gen(function* () {
    const { mcpSessionOverlay, projectId, threadId } = input;
    const resolution: OverlayResolution | null = yield* mcpSessionOverlay.resolveForTurn(projectId);
    // The file this turn actually wrote (if any) — read by withCleanup's suspend, so
    // assignment inside the spawn thunk is visible when the region settles.
    let writtenOverlayPath: string | null = null;

    const overlayChanged =
      resolution === null
        ? Effect.succeed(false)
        : mcpSessionOverlay.changedForThread(threadId, resolution.fingerprint);

    // Name WHAT changed for the respawn log: server set > tool policy > other config.
    // An unknown previous state (evicted / server restarted) cannot be discriminated —
    // it reports the generic config-changed arm.
    const respawnReason: Effect.Effect<McpOverlaySpawnReason> =
      resolution === null
        ? Effect.succeed("respawn:other")
        : Effect.map(
            Effect.zip(overlayChanged, mcpSessionOverlay.spawnState(threadId)),
            ([changed, previous]) => {
              if (!changed) return "respawn:other";
              if (previous === undefined) return "respawn:mcp-config-changed";
              if (previous.allowlistKey !== resolution.allowlistKey) {
                return "respawn:mcp-servers-changed";
              }
              if (previous.toolPolicyKey !== resolution.toolPolicyKey) {
                return "respawn:mcp-allowed-tools-changed";
              }
              return "respawn:mcp-config-changed";
            },
          );

    return {
      fingerprint: resolution?.fingerprint,
      overlayChanged,
      overlayFieldsForSpawn: (kind) =>
        resolution === null
          ? Effect.succeed({})
          : Effect.gen(function* () {
              const spawnReason =
                kind === "fresh-spawn" ? ("fresh-spawn" as const) : yield* respawnReason;
              const written = yield* mcpSessionOverlay.writeForSpawn(resolution, {
                threadId,
                spawnReason,
              });
              if (written === null) return {};
              writtenOverlayPath = written.overlayPath;
              return {
                settingsOverlayPath: written.overlayPath,
                allowedMcpServers: written.allowedServerNames,
              };
            }),
      recordSpawn:
        resolution === null
          ? Effect.void
          : mcpSessionOverlay.recordSpawn(threadId, {
              fingerprint: resolution.fingerprint,
              allowlistKey: resolution.allowlistKey,
              toolPolicyKey: resolution.toolPolicyKey,
            }),
      logReuseSkip:
        resolution === null
          ? Effect.void
          : Effect.logDebug("[mcp] overlay skipped — not written", {
              threadId,
              projectId,
              reason: "session-reused",
              servers: resolution.allowedServerNames.length,
              fingerprint: resolution.fingerprint,
            }),
      withCleanup: (effect) =>
        effect.pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              writtenOverlayPath !== null
                ? mcpSessionOverlay.deleteOverlayFile(writtenOverlayPath)
                : Effect.void,
            ),
          ),
        ),
    } satisfies McpTurnOverlay;
  });
