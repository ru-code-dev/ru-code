// Pure: effective allowed-tool set = policy intent ∩ discovered tools. Plus a
// helper to drop inert exceptions (names no longer present in the discovered set).

import type { McpTool, McpToolPolicy } from "@t3tools/contracts";

/** Names the model may call: discovered tools filtered by the policy's intent. */
export function effectiveAllowedTools(
  policy: McpToolPolicy,
  discoveredTools: ReadonlyArray<McpTool>,
): ReadonlyArray<string> {
  const exceptionSet = new Set(policy.exceptions);
  return discoveredTools
    .map((tool) => tool.name)
    .filter((toolName) => isToolAllowed(policy.defaultDecision, exceptionSet.has(toolName)));
}

function isToolAllowed(defaultDecision: "allow" | "deny", isException: boolean): boolean {
  switch (defaultDecision) {
    case "allow":
      return !isException; // allow all except the listed names
    case "deny":
      return isException; // deny all except the listed names
  }
}
