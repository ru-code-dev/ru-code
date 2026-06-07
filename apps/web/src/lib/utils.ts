import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";
import * as Random from "effect/Random";
import * as Effect from "effect/Effect";
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

export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Effect.runSync(Random.nextUUIDv4);
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
