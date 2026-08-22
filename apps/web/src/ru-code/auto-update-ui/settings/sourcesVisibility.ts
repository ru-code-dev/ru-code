// ru-code: when the settings page shows the ADVANCED sources section — the whole rule, as one
// pure function (the page-level sibling of the card's channelDisclosure.ts).
//
// The rule: the section is visible when the user opened it, when nothing works (setup is the
// only useful thing to show), or when it was ALREADY visible for that reason — a source that
// starts working under the user's hands (they just configured it and pressed «Check») must not
// yank the section away mid-interaction. Only «Hide manual setup» (or leaving the page)
// dismisses a latched section.
//
// Two things previously broke this:
//   · `working` counted a PROBING source as broken, so every hero/background check mounted the
//     section for the round's duration and unmounted it on settle — fixed at the derivation
//     (`wireToUi`: probing keeps the previous verdict);
//   · a success verdict landing while the section was open (fix-then-recheck) unmounted it
//     instantly — fixed here by the latch.

export interface SourcesSectionInput {
  /** `anySourceWorks(state)` — at least one enabled source has a working verdict. */
  readonly working: boolean;
  /** The user pressed «Configure sources manually» (client-local, sticky until hidden). */
  readonly manualSourcesOpen: boolean;
  /** The latch carried between renders — pass the previous derivation's `latchedOpen`. */
  readonly latchedOpen: boolean;
}

export interface SourcesSectionView {
  /** Render the advanced section (sources editor + history)? */
  readonly visible: boolean;
  /** Store this back; it keeps the section up once shown for a broken state. */
  readonly latchedOpen: boolean;
}

export function deriveSourcesSection(input: SourcesSectionInput): SourcesSectionView {
  const latchedOpen = input.latchedOpen || !input.working;
  return {
    visible: input.manualSourcesOpen || latchedOpen,
    latchedOpen,
  };
}
