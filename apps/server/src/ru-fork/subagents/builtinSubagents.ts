// ru-fork: snapshot of cli-code 0.13.1 BuiltinAgentRegistry.
// Source: cli-code/packages/core/src/subagents/builtin-agents.ts.
//
// We do NOT call into CLI to enumerate built-ins at runtime — CLI runs
// in a separate process and the API surface is private. Instead we mirror
// the public list (name + description) so the composer can surface them
// in the `#` picker. The model itself reads the canonical definitions
// from CLI's process when it invokes the AgentTool, so drift between
// our snapshot and CLI's list only affects the picker UI, not execution.
//
// Re-sync: when bumping cli-code, re-read
//   cli-code/packages/core/src/subagents/builtin-agents.ts
// and update this array. If CLI renames/removes an agent, our picker
// will offer it but CLI will reject the invocation (visible to user as
// an "unknown subagent" error from CLI). That's acceptable noise for
// the simplicity of a static snapshot.

import type { ServerProviderSubagent } from "@t3tools/contracts";

import { SCOPE_BUILTIN } from "./constants.ts";

// ru-fork: `name` MUST match cli-code's registry verbatim (the model
// emits `subagent_type` by name); only description/display labels are
// localized.
export const BUILTIN_SUBAGENTS: ReadonlyArray<ServerProviderSubagent> = [
  {
    name: "general-purpose",
    description: "Поиск кода и многошаговые задачи в репозитории.",
    scope: SCOPE_BUILTIN,
    enabled: true,
  },
  {
    name: "Explore",
    description: "Быстрый поиск файлов по шаблонам и кода по ключевым словам.",
    scope: SCOPE_BUILTIN,
    enabled: true,
  },
];
