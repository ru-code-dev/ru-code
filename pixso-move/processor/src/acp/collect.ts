import type { SessionNotification } from "effect-acp/schema";

// Pure delta reducer over ACP `session/update` notifications: append the text of an
// `agent_message_chunk` text block; ignore every other update kind. Folded over the stream
// to build the agent's full message.
export const accumulateDelta = (buffer: string, notification: SessionNotification): string => {
  const update = notification.update;
  if (update.sessionUpdate !== "agent_message_chunk") return buffer;
  const content = update.content;
  if (content.type !== "text") return buffer;
  return buffer + content.text;
};
