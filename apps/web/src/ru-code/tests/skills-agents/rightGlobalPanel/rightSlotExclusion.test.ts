import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { useRightPanelStore } from "~/rightPanelStore";
import { installRightSlotExclusion } from "../../../skills-agents/rightGlobalPanel/rightSlotExclusion";
import { useRightGlobalPanelStore } from "../../../skills-agents/rightGlobalPanel/store";

// A server-thread ref and a DRAFT-thread ref (a draft is a real local thread with an id +
// environmentId — see buildLocalDraftThread — so it has a valid ScopedThreadRef too).
const serverRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("server-thread"));
const draftRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("draft-thread"));

const globalOpen = () => useRightGlobalPanelStore.getState().open;
const threadOpen = (ref: typeof serverRef) =>
  useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]?.isOpen ?? false;
// THE invariant: the two panels may never both own the right slot.
const bothVisible = (ref: typeof serverRef) => globalOpen() !== null && threadOpen(ref);

let stop: () => void = () => {};

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
  useRightGlobalPanelStore.setState({ open: null });
});
afterEach(() => {
  stop();
  stop = () => {};
});

// Run every scenario against a server thread AND a draft thread — the coordinator treats them
// identically (both are valid refs), which is the point.
for (const [label, ref] of [
  ["server thread", serverRef],
  ["draft thread", draftRef],
] as const) {
  describe(`right-slot exclusion — ${label}`, () => {
    beforeEach(() => {
      stop = installRightSlotExclusion(() => ref);
    });

    it("opening SKILLS while the thread panel is open hides the thread panel", () => {
      useRightPanelStore.getState().open(ref, "diff");
      expect(threadOpen(ref)).toBe(true);

      useRightGlobalPanelStore.getState().toggle("skills");
      expect(globalOpen()).toBe("skills");
      expect(threadOpen(ref)).toBe(false); // hidden by the invariant
      expect(bothVisible(ref)).toBe(false);
    });

    it("opening the thread panel while SKILLS is open closes skills", () => {
      useRightGlobalPanelStore.getState().toggle("skills");
      useRightPanelStore.getState().open(ref, "diff");
      expect(threadOpen(ref)).toBe(true);
      expect(globalOpen()).toBeNull(); // skills closed
      expect(bothVisible(ref)).toBe(false);
    });

    it("the NO-OP re-open (re-activating an already-active hidden surface) still closes skills", () => {
      useRightPanelStore.getState().open(ref, "diff"); // thread shows diff
      useRightGlobalPanelStore.getState().toggle("skills"); // → thread hidden (isOpen=false)
      expect(threadOpen(ref)).toBe(false);

      // Re-open the SAME diff. Because the thread was hidden (isOpen=false), this is a real
      // false→true transition, so skills closes — no gap.
      useRightPanelStore.getState().open(ref, "diff");
      expect(globalOpen()).toBeNull();
      expect(threadOpen(ref)).toBe(true);
      expect(bothVisible(ref)).toBe(false);
    });

    it("switching the global overlay (skills → agents) keeps the thread hidden", () => {
      useRightPanelStore.getState().open(ref, "diff");
      useRightGlobalPanelStore.getState().toggle("skills");
      useRightGlobalPanelStore.getState().toggle("agents"); // switch overlay
      expect(globalOpen()).toBe("agents");
      expect(threadOpen(ref)).toBe(false);
      expect(bothVisible(ref)).toBe(false);
    });

    it("EVERY surface opener closes skills (diff / files / file / terminal / browser)", () => {
      const openers: Array<() => void> = [
        () => useRightPanelStore.getState().open(ref, "diff"),
        () => useRightPanelStore.getState().open(ref, "files"),
        () => useRightPanelStore.getState().openFile(ref, "src/index.ts"),
        () => useRightPanelStore.getState().openTerminal(ref, "term-1"),
        () => useRightPanelStore.getState().openBrowser(ref, "tab-1"),
      ];
      for (const openSurface of openers) {
        useRightGlobalPanelStore.getState().toggle("skills"); // skills owns the slot
        expect(globalOpen()).toBe("skills");
        openSurface(); // any thread-panel opener
        expect(globalOpen()).toBeNull(); // → skills released
        expect(bothVisible(ref)).toBe(false);
      }
    });

    it("INVARIANT holds after every step of a long mixed sequence", () => {
      const steps: Array<() => void> = [
        () => useRightPanelStore.getState().open(ref, "diff"),
        () => useRightGlobalPanelStore.getState().toggle("skills"),
        () => useRightPanelStore.getState().open(ref, "diff"), // no-op re-open
        () => useRightGlobalPanelStore.getState().toggle("agents"),
        () => useRightGlobalPanelStore.getState().toggle("agents"), // close via nav
        () => useRightPanelStore.getState().openFile(ref, "a.ts"),
        () => useRightGlobalPanelStore.getState().toggle("skills"),
        () => useRightPanelStore.getState().openTerminal(ref, "t1"),
        () => useRightGlobalPanelStore.getState().toggle("skills"),
        () => useRightPanelStore.getState().toggleVisibility(ref), // hide thread via its own toggle
        () => useRightGlobalPanelStore.getState().toggle("agents"),
      ];
      for (const step of steps) {
        step();
        expect(bothVisible(ref)).toBe(false); // never both, at any point
      }
    });
  });
}

describe("right-slot exclusion — no active thread (ref === null)", () => {
  beforeEach(() => {
    stop = installRightSlotExclusion(() => null);
  });

  it("is a safe no-op: opening skills does not throw and leaves the global panel open", () => {
    useRightGlobalPanelStore.getState().toggle("skills");
    expect(globalOpen()).toBe("skills"); // nothing to coexist with; no thread panel renders
  });
});
