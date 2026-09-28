// ru-code (S99, V2-65/V2-68): THE switches of what we hand the qwen `--acp` process — the ONE place
// their env var names are written and the ONLY place the environment is read for them.
//
// Every switch is OFF unless its `QG_` variable ("quality gate") is exactly "1" in the app
// server's environment. Production never sets them: they exist so the gate and the real-qwen rig
// (`tests/qwen/real-acp/mcpProbe`) can run the whole matrix on ONE build — the rig sets them per
// run, importing the names below instead of retyping them. The values are read once, at module
// load (a server start), and handed down as plain booleans; the packages repo gets its one
// (`alwaysLoadTools`) through the `McpManagerConfig` port, like the overlay kill-switch.
//
// What each one changes (all four off ⇒ qwen gets today's file and env, S99 brief §B.2):
//   MCP_ALWAYS_LOAD_TOOLS   `alwaysLoadTools: true` in every overlay server entry — qwen 0.21.1 then
//                           declares the server's tools to the model instead of deferring them
//                           behind `tool_search` (qwen core/src/tools/mcp-tool.ts:642).
//   MCP_INJECT_BLOCKING_ENV `QWEN_CODE_LEGACY_MCP_BLOCKING=1` on every `--acp` spawn (warm slots
//                           included): `session/new` waits for MCP discovery, so the first turn
//                           already carries the tools (qwen core/src/config/config.ts:2810-2820).
//   ACP_LOG_STDERR          every stderr line of the `--acp` process → the server debug log. Off ⇒
//                           nothing reads the stream (today's path, V2-68a); on POSIX an unread
//                           pipe queues in qwen's memory, on Windows Node's pipe stderr is
//                           blocking, so a flood can stall qwen (Node's code, not measured — S99 F1).
//   ACP_LOG_AVAILABLE_TOOLS after every turn, `qwen/status/session/context_usage {detail:true}` →
//                           the tool names the model can use, in the server debug log.

export const QG_MCP_ALWAYS_LOAD_TOOLS = "QG_MCP_ALWAYS_LOAD_TOOLS";
export const QG_MCP_INJECT_BLOCKING_ENV = "QG_MCP_INJECT_BLOCKING_ENV";
export const QG_ACP_LOG_STDERR = "QG_ACP_LOG_STDERR";
export const QG_ACP_LOG_AVAILABLE_TOOLS = "QG_ACP_LOG_AVAILABLE_TOOLS";

const isOn = (name: string): boolean => process.env[name] === "1";

export const MCP_ALWAYS_LOAD_TOOLS = isOn(QG_MCP_ALWAYS_LOAD_TOOLS);
export const MCP_INJECT_BLOCKING_ENV = isOn(QG_MCP_INJECT_BLOCKING_ENV);
export const ACP_LOG_STDERR = isOn(QG_ACP_LOG_STDERR);
export const ACP_LOG_AVAILABLE_TOOLS = isOn(QG_ACP_LOG_AVAILABLE_TOOLS);
