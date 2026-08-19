// ru-code: the resume-cursor decode / back-compat gate. Its output feeds resumeSessionId
// (session/load). A loosened guard or a version bump would silently resume onto a stale
// cursor or drop a valid resume (a fresh session just starts, no error) — so the gate gets
// direct coverage: only { schemaVersion: 1, non-empty sessionId } is accepted.
import { describe, expect, it } from "vite-plus/test";

import { parseQwenResume } from "../../qwen/QwenAdapter.ts";

describe("parseQwenResume", () => {
  it("accepts a current-version cursor and trims the id", () => {
    expect(parseQwenResume({ schemaVersion: 1, sessionId: "  s1 " })).toEqual({ sessionId: "s1" });
  });

  it("rejects a wrong/absent schema version", () => {
    for (const v of [0, 2, undefined, "1"]) {
      expect(parseQwenResume({ schemaVersion: v, sessionId: "s1" })).toBeUndefined();
    }
  });

  it("rejects a missing / empty / whitespace / non-string sessionId", () => {
    expect(parseQwenResume({ schemaVersion: 1, sessionId: "" })).toBeUndefined();
    expect(parseQwenResume({ schemaVersion: 1, sessionId: "   " })).toBeUndefined();
    expect(parseQwenResume({ schemaVersion: 1, sessionId: 42 })).toBeUndefined();
    expect(parseQwenResume({ schemaVersion: 1 })).toBeUndefined();
  });

  it("rejects non-objects", () => {
    for (const x of [null, undefined, "x", 3, []]) {
      expect(parseQwenResume(x)).toBeUndefined();
    }
  });
});
