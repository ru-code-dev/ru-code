import { describe, expect, it } from "vite-plus/test";

import { makeSessionFingerprintTracker } from "../../skills-agents/SessionFingerprintTracker.ts";

describe("SessionFingerprintTracker", () => {
  it("treats every defined source as changed when there is no record (respawn direction)", () => {
    const tracker = makeSessionFingerprintTracker();
    expect([...tracker.changedSources("t1", { skills: "a", agents: "b" })].sort()).toEqual([
      "agents",
      "skills",
    ]);
  });

  it("reports no change after recording the same fingerprints", () => {
    const tracker = makeSessionFingerprintTracker();
    tracker.record("t1", { skills: "a", agents: "b" });
    expect(tracker.changedSources("t1", { skills: "a", agents: "b" })).toEqual([]);
  });

  it("detects a changed source", () => {
    const tracker = makeSessionFingerprintTracker();
    tracker.record("t1", { skills: "a", agents: "b" });
    expect(tracker.changedSources("t1", { skills: "a2", agents: "b" })).toEqual(["skills"]);
  });

  it("ignores undefined sources (a failed fingerprint never counts as a change)", () => {
    const tracker = makeSessionFingerprintTracker();
    tracker.record("t1", { skills: "a", agents: "b" });
    expect(tracker.changedSources("t1", { skills: undefined, agents: "b" })).toEqual([]);
  });

  it("merges on record — a source that failed keeps its prior recorded value", () => {
    const tracker = makeSessionFingerprintTracker();
    tracker.record("t1", { skills: "a", agents: "b" });
    tracker.record("t1", { skills: undefined, agents: "b2" });
    expect(tracker.peek("t1")).toEqual({ skills: "a", agents: "b2" });
  });

  it("forget drops the record (next turn respawns)", () => {
    const tracker = makeSessionFingerprintTracker();
    tracker.record("t1", { skills: "a" });
    tracker.forget("t1");
    expect(tracker.peek("t1")).toBeUndefined();
    expect(tracker.changedSources("t1", { skills: "a" })).toEqual(["skills"]);
  });

  it("evicts least-recently-recorded past capacity (leak backstop)", () => {
    const tracker = makeSessionFingerprintTracker({ capacity: 2 });
    tracker.record("t1", { skills: "1" });
    tracker.record("t2", { skills: "2" });
    tracker.record("t3", { skills: "3" }); // evicts t1 (oldest)
    expect(tracker.size()).toBe(2);
    expect(tracker.peek("t1")).toBeUndefined();
    expect(tracker.peek("t3")).toEqual({ skills: "3" });
  });
});
