// ru-code: `file_path` is qwen's actual rawInput arg key — path extraction must
// not depend on a non-empty `locations` array. Covers the marked seam in
// packages/shared/src/toolActivity.ts (collectPaths).
import { describe, expect, it } from "vite-plus/test";

import { deriveToolActivityPresentation } from "../../toolActivity.ts";

describe("toolActivity file_path extraction (qwen rawInput)", () => {
  it("finds the snake_case file_path inside rawInput for file changes", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "file_change",
        title: "WriteFile: Writing to permission-test.txt",
        data: {
          kind: "edit",
          rawInput: {
            file_path: "/proj/permission-test.txt",
            content: "hello from subagent\n",
          },
        },
        fallbackSummary: "WriteFile",
      }),
    ).toEqual({
      summary: "Changed files",
      detail: "/proj/permission-test.txt",
    });
  });
});
