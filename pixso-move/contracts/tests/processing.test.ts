import { describe, expect, it } from "vitest";

import { ProcessingResult, ProcessingStatus } from "../src/processing.ts";
import { decode, rejects } from "./decode.ts";

const valid = {
  nodeId: "n-1",
  resultTag: "react",
  status: "done",
  attempts: 1,
  result: "code",
  error: null,
  createdAt: "2026-06-14T00:00:00.000Z",
  startedAt: "2026-06-14T00:00:01.000Z",
  finishedAt: "2026-06-14T00:00:02.000Z",
};

describe("ProcessingStatus", () => {
  it("decodes each known status", async () => {
    for (const s of ["pending", "processing", "done", "error"]) {
      expect(await decode(ProcessingStatus, s)).toBe(s);
    }
  });
  it("rejects an unknown status", async () => {
    expect(await rejects(ProcessingStatus, "queued")).toBe(true);
  });
});

describe("ProcessingResult", () => {
  it("decodes a completed result", async () => {
    const r = await decode(ProcessingResult, valid);
    expect(r.status).toBe("done");
    expect(r.attempts).toBe(1);
  });
  it("decodes a pending result with null fields", async () => {
    const r = await decode(ProcessingResult, {
      ...valid,
      status: "pending",
      result: null,
      startedAt: null,
      finishedAt: null,
    });
    expect(r.result).toBeNull();
    expect(r.startedAt).toBeNull();
  });
  it("rejects a negative attempts", async () => {
    expect(await rejects(ProcessingResult, { ...valid, attempts: -1 })).toBe(true);
  });
  it("rejects a non-integer attempts", async () => {
    expect(await rejects(ProcessingResult, { ...valid, attempts: 1.5 })).toBe(true);
  });
});
