// ru-code: improvements-branch-3 GUARD tests (green now) — protect the parts we're about to change.
// (1) Overlay ↔ qwen schema conformance: every key buildServerEntry emits must be a field qwen's
//     MCPServerConfig accepts — so a future change (e.g. adding `trust`, or a typo) can't silently
//     drift out of qwen's schema.
// (2) Fingerprint respawn matrix: config/toolPolicy changes flip the overlay fingerprint (qwen
//     respawns); identical input is stable; order-independent. Locks the "what triggers a restart"
//     logic before `trust` is added to it.
// No production logic touched (buildServerEntry is exported as a testability seam).

import {
  buildServerEntry,
  DEFAULT_TOOL_POLICY,
  overlayFingerprint,
  type McpToolPolicy,
  type OverlayServerEntry,
  type ResolvedServerConfig,
} from "@smart-tools/qwen-cli-mcp-manager/server";
import { describe, expect, it } from "vite-plus/test";

// The exact field set qwen 0.21.1 accepts on an mcpServers entry (MCPServerConfig constructor,
// qwen-code @ 41b4ee8373 packages/core/src/config/config.ts:773-823; S99 — 0.13.1 is retired).
// buildServerEntry must stay a subset of this.
const QWEN_MCP_SERVER_KEYS = new Set<string>([
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "httpUrl",
  "headers",
  "tcp",
  "timeout",
  "trust",
  "description",
  "includeTools",
  "excludeTools",
  "extensionName",
  "oauth",
  "authProviderType",
  "targetAudience",
  "targetServiceAccount",
  "type",
  "discoveryTimeoutMs",
  "scope",
  "alwaysLoadTools",
]);

const stdioResolved: ResolvedServerConfig = {
  transport: "stdio",
  command: "uvx",
  args: ["server"],
  env: { TOKEN: "x" },
  timeoutMs: 30_000,
};
const httpResolved: ResolvedServerConfig = {
  transport: "http",
  httpUrl: "https://example.test/mcp",
  headers: { Authorization: "Bearer x" },
  timeoutMs: 30_000,
};
const denyPolicy: McpToolPolicy = { defaultDecision: "deny", exceptions: ["read"] };

const entry = (
  serverName: string,
  resolved: ResolvedServerConfig,
  toolPolicy: McpToolPolicy,
  trust = true,
): OverlayServerEntry => ({ serverName, resolved, toolPolicy, trust });

describe("branch-3 guard — overlay ↔ qwen schema conformance", () => {
  it("stdio entry uses only keys qwen accepts + emits trust (#6)", () => {
    const entry = buildServerEntry(stdioResolved, DEFAULT_TOOL_POLICY, true, false);
    for (const key of Object.keys(entry)) {
      expect(QWEN_MCP_SERVER_KEYS.has(key)).toBe(true);
    }
    expect(entry.trust).toBe(true);
  });

  it("http entry (with tool filter) uses only keys qwen accepts + emits trust=false (#6)", () => {
    const entry = buildServerEntry(httpResolved, denyPolicy, false, false);
    for (const key of Object.keys(entry)) {
      expect(QWEN_MCP_SERVER_KEYS.has(key)).toBe(true);
    }
    expect(entry).toHaveProperty("includeTools");
    expect(entry.trust).toBe(false);
  });

  // S99: the MCP_ALWAYS_LOAD_TOOLS switch (acpSwitches.ts → McpManagerConfig.alwaysLoadTools).
  it("alwaysLoadTools on ⇒ both entry shapes carry qwen's own `alwaysLoadTools: true`", () => {
    for (const entry of [
      buildServerEntry(stdioResolved, DEFAULT_TOOL_POLICY, true, true),
      buildServerEntry(httpResolved, denyPolicy, false, true),
    ]) {
      expect(entry["alwaysLoadTools"]).toBe(true);
      for (const key of Object.keys(entry)) {
        expect(QWEN_MCP_SERVER_KEYS.has(key)).toBe(true);
      }
    }
  });

  it("alwaysLoadTools off ⇒ the entries carry no such key (today's bytes)", () => {
    for (const entry of [
      buildServerEntry(stdioResolved, DEFAULT_TOOL_POLICY, true, false),
      buildServerEntry(httpResolved, denyPolicy, false, false),
    ]) {
      expect(entry).not.toHaveProperty("alwaysLoadTools");
    }
  });
});

describe("branch-3 guard — overlay fingerprint respawn matrix", () => {
  it("identical input ⇒ identical fingerprint", () => {
    expect(overlayFingerprint([entry("a", stdioResolved, DEFAULT_TOOL_POLICY)])).toBe(
      overlayFingerprint([entry("a", stdioResolved, DEFAULT_TOOL_POLICY)]),
    );
  });

  it("a config change flips the fingerprint (⇒ respawn)", () => {
    const before = overlayFingerprint([entry("a", stdioResolved, DEFAULT_TOOL_POLICY)]);
    const after = overlayFingerprint([
      entry("a", { ...stdioResolved, args: ["server", "--flag"] }, DEFAULT_TOOL_POLICY),
    ]);
    expect(after).not.toBe(before);
  });

  it("a tool-policy change flips the fingerprint (⇒ respawn)", () => {
    const before = overlayFingerprint([entry("a", stdioResolved, DEFAULT_TOOL_POLICY)]);
    const after = overlayFingerprint([entry("a", stdioResolved, denyPolicy)]);
    expect(after).not.toBe(before);
  });

  it("a TRUST change flips the fingerprint (⇒ respawn) — #6", () => {
    const trusted = overlayFingerprint([entry("a", stdioResolved, DEFAULT_TOOL_POLICY, true)]);
    const untrusted = overlayFingerprint([entry("a", stdioResolved, DEFAULT_TOOL_POLICY, false)]);
    expect(untrusted).not.toBe(trusted);
  });

  it("is order-independent across servers", () => {
    const left = overlayFingerprint([
      entry("a", stdioResolved, DEFAULT_TOOL_POLICY),
      entry("b", httpResolved, DEFAULT_TOOL_POLICY),
    ]);
    const right = overlayFingerprint([
      entry("b", httpResolved, DEFAULT_TOOL_POLICY),
      entry("a", stdioResolved, DEFAULT_TOOL_POLICY),
    ]);
    expect(left).toBe(right);
  });
});
