import type { AcpError } from "effect-acp/errors";
import type {
  AuthenticateRequest,
  ContentBlock,
  InitializeRequest,
  NewSessionRequest,
  PromptResponse,
} from "effect-acp/schema";

import { AcpRunError } from "../types.ts";

// Pure builders / mappers for the ACP handshake. Constants verified against
// apps/server AcpSessionRuntime.ts + config.ts (CLI_AUTH_METHOD_ID = "openai").

export const initializeParams = (): InitializeRequest => ({
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "pixso-move", version: "0.0.0" },
});

export const authenticateParams = (methodId: string): AuthenticateRequest => ({ methodId });

export const newSessionParams = (cwd: string): NewSessionRequest => ({ cwd, mcpServers: [] });

export const promptBlocks = (prompt: string): ReadonlyArray<ContentBlock> => [
  { type: "text", text: prompt },
];

export const mapStopReason = (response: PromptResponse): string => response.stopReason;

export const mapAcpError = (error: AcpError): AcpRunError =>
  new AcpRunError({ message: `${error._tag}: ${JSON.stringify(error)}` });
