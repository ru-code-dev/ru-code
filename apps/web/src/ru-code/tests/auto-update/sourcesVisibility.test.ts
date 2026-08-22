// ru-code: the settings page's advanced-section visibility (production-error.md §4) — driven
// as SCENARIOS through the pure rule, the way the page replays it across renders.

import { describe, expect, it } from "vite-plus/test";

import { deriveSourcesSection } from "../../auto-update-ui/settings/sourcesVisibility";

/** Replay a sequence of render inputs, threading the latch exactly like the page does. */
function replay(
  steps: ReadonlyArray<{ working: boolean; manualSourcesOpen: boolean; hidePressed?: boolean }>,
): ReadonlyArray<boolean> {
  let latchedOpen = false;
  const visibility: boolean[] = [];
  for (const step of steps) {
    if (step.hidePressed) latchedOpen = false; // the Hide button resets the latch
    const next = deriveSourcesSection({
      working: step.working,
      manualSourcesOpen: step.hidePressed ? false : step.manualSourcesOpen,
      latchedOpen,
    });
    latchedOpen = next.latchedOpen;
    visibility.push(next.visible);
  }
  return visibility;
}

describe("deriveSourcesSection", () => {
  it("a healthy state keeps the section hidden — including through a check (working never dips)", () => {
    // With the wireToUi fix, `working` stays true through probing; the page must stay compact.
    expect(replay([{ working: true, manualSourcesOpen: false }])).toEqual([false]);
    expect(
      replay([
        { working: true, manualSourcesOpen: false },
        { working: true, manualSourcesOpen: false }, // hero check in flight
        { working: true, manualSourcesOpen: false }, // round settled ok
      ]),
    ).toEqual([false, false, false]);
  });

  it("nothing works ⇒ the section shows, and STAYS after the user fixes a source (no sudden collapse)", () => {
    expect(
      replay([
        { working: false, manualSourcesOpen: false }, // broken ⇒ shown
        { working: false, manualSourcesOpen: false }, // user configures
        { working: true, manualSourcesOpen: false }, // per-source recheck succeeds — must NOT unmount
        { working: true, manualSourcesOpen: false },
      ]),
    ).toEqual([true, true, true, true]);
  });

  it("«Hide manual setup» dismisses the latched section; it stays hidden while things work", () => {
    expect(
      replay([
        { working: false, manualSourcesOpen: false },
        { working: true, manualSourcesOpen: false },
        { working: true, manualSourcesOpen: false, hidePressed: true },
        { working: true, manualSourcesOpen: false },
      ]),
    ).toEqual([true, true, false, false]);
  });

  it("manually opened section survives a successful recheck (user's own open wins)", () => {
    expect(
      replay([
        { working: true, manualSourcesOpen: true }, // «Configure sources manually»
        { working: true, manualSourcesOpen: true }, // per-source recheck: probing (working held)
        { working: true, manualSourcesOpen: true }, // settled ok — still open
      ]),
    ).toEqual([true, true, true]);
  });

  it("breaking again after a hide re-shows the section", () => {
    expect(
      replay([
        { working: true, manualSourcesOpen: false },
        { working: false, manualSourcesOpen: false },
        { working: true, manualSourcesOpen: false, hidePressed: true },
        { working: false, manualSourcesOpen: false },
      ]),
    ).toEqual([false, true, false, true]);
  });
});
