// Pure: a project's overlay fingerprint. Two projects with the same enabled set,
// same resolved configs, and same tool policies share a fingerprint; any change
// flips it, which is what drives "restart the ACP session" decisions.
//
// The fingerprint depends on the tool POLICY, not on discovered tools: the overlay
// hands qwen include/excludeTools and qwen intersects with whatever it discovers,
// so a server gaining/losing a tool does not require a restart.

import type { McpToolPolicy } from "@t3tools/contracts";

import { dedupHash, type ResolvedServerConfig } from "./resolver.ts";

export interface OverlayServerEntry {
  readonly serverName: string;
  readonly resolved: ResolvedServerConfig;
  readonly toolPolicy: McpToolPolicy;
  // ru-fork #6: catalog «доверять» flag — part of the fingerprint so a trust change respawns qwen.
  readonly trust: boolean;
}

/** Deterministic fingerprint of the full enabled overlay for one project. */
export function overlayFingerprint(entries: ReadonlyArray<OverlayServerEntry>): string {
  const canonicalEntries = entries
    .map((entry) => ({
      serverName: entry.serverName,
      configHash: dedupHash(entry.resolved),
      defaultDecision: entry.toolPolicy.defaultDecision,
      exceptions: entry.toolPolicy.exceptions.toSorted(),
      trust: entry.trust,
    }))
    .toSorted((left, right) => left.serverName.localeCompare(right.serverName));
  return dedupHash({ transport: "stdio", args: [JSON.stringify(canonicalEntries)] });
}
