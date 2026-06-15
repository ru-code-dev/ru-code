import { AcpProtocolParseError } from "effect-acp/errors";
import type { PromptResponse } from "effect-acp/schema";
import { describe, expect, it } from "vitest";

import {
  authenticateParams,
  initializeParams,
  mapAcpError,
  mapStopReason,
  newSessionParams,
  promptBlocks,
} from "../src/acp/handshake.ts";
import { AcpRunError } from "../src/types.ts";

describe("handshake builders", () => {
  it("initializeParams advertises no fs/terminal and protocol v1", () => {
    const params = initializeParams();
    expect(params.protocolVersion).toBe(1);
    expect(params.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    expect(params.clientInfo?.name).toBe("pixso-move");
  });

  it("authenticateParams carries the method id", () => {
    expect(authenticateParams("openai")).toEqual({ methodId: "openai" });
  });

  it("newSessionParams carries cwd and no MCP servers", () => {
    expect(newSessionParams("/work")).toEqual({ cwd: "/work", mcpServers: [] });
  });

  it("promptBlocks wraps the prompt in a single text block", () => {
    expect(promptBlocks("hi")).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("response mappers", () => {
  it("mapStopReason returns the stop reason", () => {
    const response = { stopReason: "end_turn" } as PromptResponse;
    expect(mapStopReason(response)).toBe("end_turn");
  });

  it("mapAcpError builds an AcpRunError mentioning the tag", () => {
    const mapped = mapAcpError(new AcpProtocolParseError({ detail: "bad" }));
    expect(mapped).toBeInstanceOf(AcpRunError);
    expect(mapped.message).toContain("AcpProtocolParseError");
  });
});
