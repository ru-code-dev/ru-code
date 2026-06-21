// ru-fork: writes a project's qwen settings overlay — the single source of
// truth for which MCP servers + tools that project's qwen sees. This is the
// only place the overlay JSON shape is constructed; CliAdapter stays
// MCP-agnostic and just forwards the resulting path + allowlist to the spawn.
//
// The overlay file (`<mcpOverlayDir>/<projectId>/system.json`) is read by qwen
// via QWEN_CODE_SYSTEM_SETTINGS_PATH at highest precedence. It disables folder
// trust (so MCP discovery is ungated) and lists every ENABLED binding with its
// resolved config + policy-derived include/excludeTools. include/excludeTools
// come straight from the tool POLICY (default-allow → excludeTools: exceptions;
// default-deny → includeTools: exceptions), NOT from discovered tools — qwen
// intersects with what it discovers, so a server gaining/losing a tool needs no
// restart. This matches `overlayFingerprint`, which is also policy-based.
//
// Shapes (command/args/env, httpUrl/headers, includeTools/excludeTools,
// security.folderTrust, --allowed-mcp-server-names) are exactly what the
// mcp-probe proved against real qwen 0.13.1.

import {
  McpError,
  type McpToolPolicy,
  type ProjectId,
} from "@t3tools/contracts";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  effectiveTimeoutMs,
  missingRequiredVars,
  overlayFingerprint,
  type OverlayServerEntry,
  resolveConfig,
  type ResolvedServerConfig,
} from "@ru-fork/mcp-core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpBindingRepository } from "../../persistence/Services/McpBinding.ts";
import { McpCatalogRepository } from "../../persistence/Services/McpCatalog.ts";
import { materializeSecretValues, missingSecretVarNames } from "./McpSecrets.ts";

/** What the spawn needs (path + allowlist) plus the fingerprint for restart diffing. */
export interface OverlayResult {
  readonly overlayPath: string;
  readonly allowedServerNames: ReadonlyArray<string>;
  readonly fingerprint: string;
}

export interface McpOverlayShape {
  /**
   * (Re)write the project's overlay file from current catalog + bindings and
   * return its path, server allowlist, and fingerprint. Atomic write — a partial
   * file is never observed.
   */
  readonly writeOverlay: (projectId: ProjectId) => Effect.Effect<OverlayResult, McpError>;
  /**
   * B4 ③: remove a deleted project's overlay directory (best-effort — a missing
   * dir is a no-op). Never fails (errors are swallowed), so callers need no recovery.
   */
  readonly removeOverlay: (projectId: ProjectId) => Effect.Effect<void>;
  /**
   * ru-fork #4 ephemeral: delete a single resolved overlay FILE the moment the spawn
   * it fed has settled. The file holds plaintext secrets and is only needed until the
   * freshly-spawned child boots and reads it (qwen reads settings once at startup,
   * never re-reads). Best-effort — a missing file is a no-op; never fails, so it is
   * safe inside `Effect.ensuring`. `force` swallows ENOENT.
   */
  readonly deleteOverlayFile: (overlayPath: string) => Effect.Effect<void>;
  /**
   * ru-fork #4 ephemeral: sweep EVERY project's overlay under `mcpOverlayDir`. Used on
   * app start to clear plaintext-secret files a hard crash (SIGKILL/power-loss) left
   * behind. Best-effort — a missing dir is a no-op; never fails. The dir is recreated
   * lazily by the next `writeOverlay` (atomic write makes its parents).
   */
  readonly removeAllOverlays: Effect.Effect<void>;
}

export class McpOverlay extends Context.Service<McpOverlay, McpOverlayShape>()(
  "@ru-code/ru-code/ru-fork/mcp/McpOverlay",
) {}

/** qwen mcpServers entry: resolved transport fields + policy-derived tool filter.
 * ru-fork: exported as a testability seam (overlay↔qwen schema-conformance guard). */
export function buildServerEntry(
  resolved: ResolvedServerConfig,
  policy: McpToolPolicy,
  trust: boolean,
): Record<string, unknown> {
  const toolFilter: Record<string, ReadonlyArray<string>> =
    policy.defaultDecision === "deny"
      ? { includeTools: [...policy.exceptions] } // deny-all-but: empty ⇒ no tools
      : policy.exceptions.length > 0
        ? { excludeTools: [...policy.exceptions] } // allow-all-but; empty ⇒ omit
        : {};
  // qwen reads `timeout` (ms) from the server entry — write the SAME value the
  // probe uses so the monitor and the real session behave identically.
  const timeout = resolved.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  // ru-fork #6: qwen's per-server auto-approve flag. true ⇒ tools run without confirmation (folder is
  // trusted); false ⇒ qwen asks for write tools. The field name is qwen's own `trust`.
  switch (resolved.transport) {
    case "stdio":
      return {
        command: resolved.command ?? "",
        args: [...(resolved.args ?? [])],
        env: { ...resolved.env },
        // qwen scopes the stdio process to `cwd` (the project dir); the probe does too.
        ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
        timeout,
        ...toolFilter,
        trust,
      };
    case "http":
      return {
        httpUrl: resolved.httpUrl ?? "",
        headers: { ...resolved.headers },
        timeout,
        ...toolFilter,
        trust,
      };
  }
}

const make = Effect.gen(function* () {
  const catalogRepository = yield* McpCatalogRepository;
  const bindingRepository = yield* McpBindingRepository;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secretStore = yield* ServerSecretStore;

  const provideIo = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const provideSecretStore = Effect.provideService(ServerSecretStore, secretStore);

  const writeOverlay: McpOverlayShape["writeOverlay"] = (projectId) =>
    Effect.gen(function* () {
      const shell = yield* snapshotQuery.getProjectShellById(projectId);
      const projectCwd = Option.match(shell, {
        onNone: () => null,
        onSome: (projectShell) => projectShell.workspaceRoot,
      });

      const catalog = yield* catalogRepository.listAll();
      const serverById = new Map(catalog.map((server) => [server.id, server]));
      const bindings = yield* bindingRepository.listByProject({ projectId });

      const mcpServers: Record<string, unknown> = {};
      const allowedServerNames: string[] = [];
      const fingerprintEntries: OverlayServerEntry[] = [];

      // A missing project cwd means no `${PROJECT_CWD}` expansion is possible —
      // emit an empty overlay rather than a half-resolved one.
      if (projectCwd !== null) {
        for (const binding of bindings) {
          if (!binding.enabled) {
            continue;
          }
          const server = serverById.get(binding.serverId);
          if (!server) {
            continue;
          }
          if (!server.enabled) {
            continue; // ⑬ catalog-disabled ⇒ excluded from the qwen overlay (binding stays, shown grayed)
          }
          // Skip incomplete bindings — qwen must never spawn with an empty required
          // value; the UI flags them «требует настройки» (§D8).
          if (missingRequiredVars(server.vars, binding.varValues).length > 0) {
            continue;
          }
          // ru-fork #9: a declared required secret whose stored value is gone ⇒ incomplete; never
          // hand qwen a blank credential (defense in depth with computeDesiredEffect).
          if (
            (yield* missingSecretVarNames(server.vars, binding.varValues).pipe(provideSecretStore))
              .length > 0
          ) {
            continue;
          }
          const secretValues = yield* materializeSecretValues(
            server.vars,
            binding.varValues,
          ).pipe(provideSecretStore);
          // Per-server resolved env (the vars) lives ONLY in this server's entry, so
          // secrets are isolated per MCP (never in a shared env) — see §D11.
          const resolved = resolveConfig({
            config: server.config,
            vars: server.vars,
            varValues: binding.varValues,
            extraArgs: server.extraArgs,
            extraHeaders: server.extraHeaders,
            timeoutMs: effectiveTimeoutMs(server, binding),
            context: { projectCwd, secretValues },
          });
          mcpServers[binding.serverId] = buildServerEntry(resolved, binding.toolPolicy, server.trust);
          allowedServerNames.push(binding.serverId);
          fingerprintEntries.push({
            serverName: binding.serverId,
            resolved,
            toolPolicy: binding.toolPolicy,
            trust: server.trust,
          });
        }
      }

      const overlayPath = path.join(serverConfig.mcpOverlayDir, projectId, "system.json");
      // This is qwen's external settings.json format, not one of our schemas —
      // plain JSON is the right tool, so the prefer-Schema heuristic is off here.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const contents = JSON.stringify(
        { security: { folderTrust: { enabled: false } }, mcpServers },
        null,
        2,
      );
      // mode 0600 / dir 0700: the overlay holds resolved secret values, so it must
      // match the secret store's owner-only protection, not the default umask (§D13).
      yield* provideIo(
        writeFileStringAtomically({ filePath: overlayPath, contents, mode: 0o600, dirMode: 0o700 }),
      );

      const fingerprint = overlayFingerprint(fingerprintEntries);
      yield* Effect.logDebug("[mcp] overlay written", {
        projectId,
        path: overlayPath,
        servers: allowedServerNames.length,
        allowedServerNames,
        fingerprint,
      });

      return { overlayPath, allowedServerNames, fingerprint } satisfies OverlayResult;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new McpError({ detail: `Failed to write MCP overlay for project ${projectId}`, cause }),
      ),
    );

  const removeOverlay: McpOverlayShape["removeOverlay"] = (projectId) =>
    provideIo(
      fileSystem.remove(path.join(serverConfig.mcpOverlayDir, projectId), {
        recursive: true,
        force: true,
      }),
    ).pipe(
      // ru-fork: best-effort cleanup — `force` makes a missing dir a no-op; a real failure is logged (the
      // dir holds resolved secrets) but must not fail the project.deleted chain.
      Effect.catchCause((cause) =>
        Effect.logDebug("mcp overlay: failed to remove project overlay", { projectId, cause }),
      ),
    );

  const deleteOverlayFile: McpOverlayShape["deleteOverlayFile"] = (overlayPath) =>
    provideIo(fileSystem.remove(overlayPath, { force: true })).pipe(
      // ru-fork #4: best-effort — never fails (safe under Effect.ensuring). `force` makes a
      // missing file a no-op; a real failure is debug (non-blocking — sweep-on-start nets it).
      Effect.catchCause((cause) =>
        Effect.logDebug("mcp overlay: failed to delete ephemeral overlay file", {
          overlayPath,
          cause,
        }),
      ),
    );

  const removeAllOverlays: McpOverlayShape["removeAllOverlays"] = provideIo(
    fileSystem.remove(serverConfig.mcpOverlayDir, { recursive: true, force: true }),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug("mcp overlay: failed to sweep overlay dir", {
        dir: serverConfig.mcpOverlayDir,
        cause,
      }),
    ),
  );

  return {
    writeOverlay,
    removeOverlay,
    deleteOverlayFile,
    removeAllOverlays,
  } satisfies McpOverlayShape;
});

export const McpOverlayLive = Layer.effect(McpOverlay, make);
