// ru-fork: advanced chat mode — per-type narrowings of the TranscriptRecord union.
import type { TranscriptRecord } from "@t3tools/contracts";

export type UserRecord = Extract<TranscriptRecord, { type: "user" }>;
export type AssistantRecord = Extract<TranscriptRecord, { type: "assistant" }>;
export type ToolResultRecord = Extract<TranscriptRecord, { type: "tool_result" }>;
export type SystemRecord = Extract<TranscriptRecord, { type: "system" }>;
