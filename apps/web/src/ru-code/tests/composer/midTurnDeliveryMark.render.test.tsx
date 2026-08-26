// ru-code (mid-turn wave, P3d): RENDER-LEVEL coverage of the delivery mark —
// the markup the user actually sees on a balloon, not just the rule behind it.
//
// P3c pinned the RULE (`midTurnDeliveryMark`) with 5 specs and left the render
// unasserted; that was an OPEN item and this closes it. Same pattern as
// `pendingApprovalPanel.render.test.tsx`: `renderToStaticMarkup` over the real
// component.
//
// SCOPE, stated rather than implied: this renders the real
// `MidTurnDeliveryMarkIcon` — the exact component `MessagesTimeline` mounts —
// but NOT the whole `UserTimelineRow`. That row and its two contexts are
// unexported internals of a PORT file, and exporting them purely for a test
// would be a port change made for our convenience (R4/R5).
//
// The ROW's half of the contract — that it mounts this component, with the
// message's own state, outside the hover-gated footer — is covered by
// `ru-code/e2e/tests/midTurnDelivery.e2e.test.ts`, in a real browser against
// the real built app. An earlier draft asserted it by grepping the port file's
// source from here; that is both weaker than the e2e and illegal in web code
// (the repo bans node builtins there), so it was dropped rather than worked
// around.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MidTurnDeliveryMarkIcon } from "../../composer/MidTurnDeliveryMarkIcon";

const render = (state: "pending" | "delivered" | "not-delivered" | undefined) =>
  renderToStaticMarkup(<MidTurnDeliveryMarkIcon state={state} />);

describe("MidTurnDeliveryMarkIcon — rendered markup per state", () => {
  it("pending renders a visible clock with an accessible name", () => {
    const markup = render("pending");
    expect(markup).not.toBe("");
    // role+label are how a screen reader gets this; the icon is aria-hidden.
    expect(markup).toContain('role="status"');
    expect(markup).toContain("aria-label=");
    expect(markup).toContain("<svg");
    // The mark must not be hover-gated — a clock nobody can see is not a clock.
    expect(markup).not.toContain("opacity-0");
    expect(markup).not.toContain("group-hover");
  });

  it("not-delivered renders a distinct icon and a destructive colour", () => {
    const markup = render("not-delivered");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("text-destructive");
    // Distinct from pending: same markup for both states would make the two
    // outcomes indistinguishable at a glance, which is the whole point.
    expect(markup).not.toBe(render("pending"));
  });

  it("delivered renders NOTHING", () => {
    // A delivered message is just a message. A tick here would mark the
    // overwhelmingly common case to signal the absence of a problem.
    expect(render("delivered")).toBe("");
  });

  it("an ordinary message renders NOTHING", () => {
    expect(render(undefined)).toBe("");
  });

  it("no native title attribute — the repo bans it as a tooltip", () => {
    // t3code(no-native-title-tooltip). Pinned so a future edit that "helpfully"
    // adds a tooltip fails here rather than at lint time in someone else's PR.
    expect(render("pending")).not.toContain("title=");
    expect(render("not-delivered")).not.toContain("title=");
  });
});
