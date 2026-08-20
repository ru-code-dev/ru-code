// ru-code: tells the server which project the client is viewing so the MCP supervisor
// scopes auto-probing to it (mounted in the chat route — probing follows the user even
// while the MCP panel is closed). Fire-and-forget: a transient failure only delays the
// scope update until the next project change.

import { useEffect } from "react";

import { ProjectId } from "@smart-tools/qwen-cli-mcp-manager/contracts";

import { usePrimaryEnvironmentId } from "~/state/environments";

import { useActiveProjectId } from "../skills-agents/catalog/activeProject";
import { mcpSetActiveProject } from "./mcpActions";

export function McpActiveProjectSync() {
  const environmentId = usePrimaryEnvironmentId();
  const activeProjectId = useActiveProjectId();

  useEffect(() => {
    if (environmentId === null) {
      return;
    }
    void mcpSetActiveProject(
      environmentId,
      activeProjectId === null ? null : ProjectId.make(activeProjectId),
    ).catch(() => undefined);
  }, [environmentId, activeProjectId]);

  return null;
}
