// ru-code: draft-first send selector — the extended view's synthetic bubble
// must carry EXACTLY the active send's optimistic payload (same MessageId as
// the send anchor), and nothing when there is no active send.
import { describe, expect, it } from "vite-plus/test";

import { selectPendingSendFor } from "../../extended-chat/pendingSend";

const MESSAGES = [
  { id: "m-1", text: "первое", createdAt: "2026-07-20T10:00:00.000Z" },
  { id: "m-2", text: "второе", createdAt: "2026-07-20T10:05:00.000Z" },
];

describe("selectPendingSendFor", () => {
  it("selects the entry matching the anchor id", () => {
    expect(selectPendingSendFor(MESSAGES, "m-2")).toEqual({
      id: "m-2",
      text: "второе",
      createdAt: "2026-07-20T10:05:00.000Z",
    });
  });

  it("null anchor or missing entry → null (no synthetic bubble)", () => {
    expect(selectPendingSendFor(MESSAGES, null)).toBeNull();
    expect(selectPendingSendFor(MESSAGES, "m-3")).toBeNull();
    expect(selectPendingSendFor([], "m-1")).toBeNull();
  });
});
