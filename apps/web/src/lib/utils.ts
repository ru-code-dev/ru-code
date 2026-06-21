import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { type CxOptions, cx } from "class-variance-authority";
import * as Encoding from "effect/Encoding";
import { twMerge } from "tailwind-merge";
import { DraftId } from "../composerDraftStore";

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

export function isLinuxPlatform(platform: string): boolean {
  return /linux/i.test(platform);
}

export function randomHex(byteLength: number): string {
  return Encoding.encodeHex(globalThis.crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function randomUUID(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Encoding.encodeHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const newCommandId = (): CommandId => CommandId.make(randomUUID());

export const newProjectId = (): ProjectId => ProjectId.make(randomUUID());

export const newThreadId = (): ThreadId => ThreadId.make(randomUUID());

export const newDraftId = (): DraftId => DraftId.make(randomUUID());

export const newMessageId = (): MessageId => MessageId.make(randomUUID());

const CLI_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The CLI ACP session id is embedded in every assistant message id the server
 * streams to the web: `assistant:assistant:<cliSessionId>:r<instance>:segment:<n>`.
 * The outer `assistant:` is added by orchestration ingestion; the inner
 * `assistant:<sessionId>:r…` is the provider's ACP item id. Returns the session
 * id usable with `<cli> --resume <id>`, or null for user/system/error ids and
 * provider ids that carry no session (turn-id fallback ids).
 */
export const cliSessionIdFromAssistantMessageId = (
  assistantMessageId: string | null | undefined,
): string | null => {
  if (!assistantMessageId) return null;
  const segments = assistantMessageId.split(":");
  if (segments[0] !== "assistant" || segments[1] !== "assistant") return null;
  const candidate = segments[2]?.trim();
  return candidate && CLI_SESSION_ID_PATTERN.test(candidate) ? candidate : null;
};

/**
 * Scans a thread's ordered message ids newest→oldest and returns the first CLI
 * session id found (the latest live session), or null. Works on ids alone — the
 * session id lives in the assistant message id, so message bodies aren't needed.
 */
export const cliSessionIdFromMessageIds = (
  messageIds: ReadonlyArray<string> | undefined,
): string | null => {
  if (!messageIds) return null;
  for (let index = messageIds.length - 1; index >= 0; index--) {
    const cliSessionId = cliSessionIdFromAssistantMessageId(messageIds[index]);
    if (cliSessionId) return cliSessionId;
  }
  return null;
};
