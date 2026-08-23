// ru-code: EN-identity pin for the AgentSpawnCtaRow bilingual seams (MessagesTimeline.tsx —
// see the `// ru-code:` marks around the `lead`/`status` locals). These seams use Lp
// (bilingual plural seam, Sidebar.tsx:255-262 shape) because English's 2-way singular/
// plural split can't carry Russian's one/few/many agreement. This test pins the ENGLISH
// render at n=1/n=3/n=5 exactly as it renders today — the Russian side is proven by the
// dict/build gates (localize:check / localize:guard / build), not here. The test runner
// defaults to English locale (locale.ts: VITEST ⇒ "en"), so Lp(...) below exercises the
// same branch the component takes without needing setLocale.
import { L, Lp } from "@ru-code/localization";
import { describe, expect, it } from "vite-plus/test";

// Mirrors MessagesTimeline.tsx's `lead` seam exactly (same Lp arguments, same shape).
function leadFor(agentCount: number, live: boolean): string {
  return live
    ? Lp(
        agentCount,
        [`Kicked off ${agentCount} subagent`, `Kicked off ${agentCount} subagents`],
        [
          `Запущен ${agentCount} субагент`,
          `Запущено ${agentCount} субагента`,
          `Запущено ${agentCount} субагентов`,
        ],
      )
    : Lp(
        agentCount,
        [`Ran ${agentCount} subagent`, `Ran ${agentCount} subagents`],
        [
          `Отработал ${agentCount} субагент`,
          `Отработало ${agentCount} субагента`,
          `Отработало ${agentCount} субагентов`,
        ],
      );
}

// Mirrors MessagesTimeline.tsx's "N working" seams (livePhase.activeCount / working branches).
function workingCountFor(count: number): string {
  return `${count} ${Lp(count, ["working", "working"], ["работает", "работают", "работают"])}`;
}

// Mirrors MessagesTimeline.tsx's CTA link-label ternary (DISPATCH 3): live branch is a
// whole-phrase dict swap ("Open Agents ▸", untouched literal in source — the transform
// places the dict entry); settled branch pairs just the word via inline L, glyph literal.
function ctaLinkLabelFor(live: boolean): string {
  return live ? "Open Agents ▸" : `${L("View", "Открыть")} ▸`;
}

describe("AgentSpawnCtaRow bilingual seams — EN identity (MessagesTimeline.tsx)", () => {
  it("`Kicked off N subagent(s)` — n=1/n>1 matches today's exact English", () => {
    expect(leadFor(1, true)).toBe("Kicked off 1 subagent");
    expect(leadFor(2, true)).toBe("Kicked off 2 subagents");
  });

  it("`Kicked off N subagent(s)` — pinned at n=1/n=3/n=5", () => {
    expect(leadFor(1, true)).toBe("Kicked off 1 subagent");
    expect(leadFor(3, true)).toBe("Kicked off 3 subagents");
    expect(leadFor(5, true)).toBe("Kicked off 5 subagents");
  });

  it("`Ran N subagent(s)` — n=1/n>1 matches today's exact English", () => {
    expect(leadFor(1, false)).toBe("Ran 1 subagent");
    expect(leadFor(2, false)).toBe("Ran 2 subagents");
  });

  it("`Ran N subagent(s)` — pinned at n=1/n=3/n=5", () => {
    expect(leadFor(1, false)).toBe("Ran 1 subagent");
    expect(leadFor(3, false)).toBe("Ran 3 subagents");
    expect(leadFor(5, false)).toBe("Ran 5 subagents");
  });

  it("`N working` (activeCount / working branches) — pinned at n=1/n=3/n=5, English invariant", () => {
    expect(workingCountFor(1)).toBe("1 working");
    expect(workingCountFor(3)).toBe("3 working");
    expect(workingCountFor(5)).toBe("5 working");
  });

  it("CTA link label — live/settled branches match today's exact English (DISPATCH 3)", () => {
    expect(ctaLinkLabelFor(true)).toBe("Open Agents ▸");
    expect(ctaLinkLabelFor(false)).toBe("View ▸");
  });
});
