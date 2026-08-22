// ru-code: the EXACT qwen 0.13.1 logged permission-request shapes. The presentation
// DETAIL (file path) must beat the generic presentation TITLE («Changed files») —
// `command ?? detail ?? title` — and `file_path` must be extracted from rawInput
// without relying on `locations`. Covers the marked seam in
// apps/server/src/provider/acp/AcpRuntimeModel.ts (parsePermissionRequest).
import { describe, expect, it } from "vite-plus/test";

import { parsePermissionRequest } from "../../../../provider/acp/AcpRuntimeModel.ts";

describe("parsePermissionRequest detail precedence (qwen 0.13.1 shapes)", () => {
  it("a WriteFile request derives the file path, not the generic title", () => {
    const request = parsePermissionRequest({
      sessionId: "session-1",
      options: [{ optionId: "proceed_once", name: "Yes, allow once", kind: "allow_once" }],
      toolCall: {
        toolCallId: "write-1",
        title: "WriteFile: Writing to permission-test.txt",
        kind: "edit",
        status: "pending",
        rawInput: {
          file_path: "/proj/permission-test.txt",
          content: "hello from subagent\n",
        },
        content: [
          {
            type: "content",
            content: { type: "text", text: "hello from subagent\n" },
          },
        ],
      },
    });

    expect(request.kind).toBe("edit");
    expect(request.detail).toBe("/proj/permission-test.txt");
  });

  it("a WriteFile request WITHOUT locations still derives the path from rawInput", () => {
    const request = parsePermissionRequest({
      sessionId: "session-1",
      options: [],
      toolCall: {
        toolCallId: "write-2",
        title: "WriteFile: Writing to notes.md",
        kind: "edit",
        status: "pending",
        rawInput: { file_path: "/proj/docs/notes.md", content: "# notes\n" },
      },
    });

    expect(request.detail).toBe("/proj/docs/notes.md");
  });

  it("a shell request keeps deriving the command (unchanged behavior)", () => {
    const request = parsePermissionRequest({
      sessionId: "session-1",
      options: [],
      toolCall: {
        toolCallId: "shell-1",
        title: "Shell: sudo ls -la /var/root",
        kind: "execute",
        status: "pending",
        rawInput: { command: "sudo ls -la /var/root" },
      },
    });

    expect(request.detail).toBe("sudo ls -la /var/root");
    expect(request.toolCall?.command).toBe("sudo ls -la /var/root");
  });
});
