// ru-code: the composer seams a dropped-in plugin depends on (mvp-plan D7, §1.4).
//
// Three properties, each of which the demo plugin's showcase rests on:
//   * a `registerItem` row reaches the right trigger's menu, in its own labelled section, and
//     the reader's query filters it like every other row;
//   * `attach` lands a context card on the ACTIVE draft and `detach` removes it — with no
//     active target, `attach` is a toast and never a throw;
//   * an async prompt that resolves after the reader kept typing is a NO-OP: the
//     `applyPromptReplacement` `expectedText` guard returns false (mvp-plan §6 risk 2).

import { beforeEach, describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import type { PluginComposerItem } from "@smart-tools/plugin-sdk/host";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  ComposerCommandMenu,
  type ComposerCommandItem,
} from "~/components/chat/ComposerCommandMenu";
import { useComposerDraftStore, DraftId } from "~/composerDraftStore";

import { setActiveComposerTarget } from "../composer/activeComposerTarget";
import {
  allPluginComposerItems,
  attachPluginCard,
  detachPluginCard,
  mergePluginComposerItems,
  pluginCardId,
  pluginComposerItemId,
  pluginComposerItems,
  pluginReviewComment,
  registerComposerItem,
  resetPluginComposerItems,
  resolvePluginComposerPrompt,
  usePluginComposerItemsRevision,
  type PluginComposerMenuItem,
} from "./composerRegistry";
import { groupPluginComposerItems } from "./composerMenuGroups";
import { getPendingPluginProblems, resetPluginProblems } from "./problems";
import { recordPluginDisplayName, resetPluginDisplayNames } from "./status";

const item = (over: Partial<PluginComposerItem> = {}): PluginComposerItem => ({
  trigger: "command",
  name: "demo-command",
  label: "/demo-command",
  description: "Insert the demo prompt",
  prompt: "Do the demo thing",
  ...over,
});

const nativeRow: ComposerCommandItem = {
  id: "slash:model",
  type: "slash-command",
  command: "model",
  label: "/model",
  description: "Pick a model",
};

beforeEach(() => {
  resetPluginComposerItems();
  resetPluginProblems();
  resetPluginDisplayNames();
  setActiveComposerTarget(null);
});

describe("registerComposerItem", () => {
  it("mints `plugin:<pluginId>:<trigger>:<name>` and keeps the plugin's fields", () => {
    registerComposerItem("demo", item());
    const rows = allPluginComposerItems();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("plugin:demo:command:demo-command");
    expect(rows[0]?.id).toBe(pluginComposerItemId("demo", "command", "demo-command"));
    expect(rows[0]?.type).toBe("plugin-item");
    expect(rows[0]?.pluginId).toBe("demo");
    expect(rows[0]?.label).toBe("/demo-command");
    expect(rows[0]?.description).toBe("Insert the demo prompt");
  });

  it("namespaces by plugin AND by trigger, so neither collides", () => {
    registerComposerItem("demo", item());
    registerComposerItem("other", item());
    registerComposerItem("demo", item({ trigger: "skill" }));
    expect(allPluginComposerItems().map((row) => row.id)).toEqual([
      "plugin:demo:command:demo-command",
      "plugin:other:command:demo-command",
      "plugin:demo:skill:demo-command",
    ]);
  });

  it("replaces on a duplicate registration rather than growing the menu", () => {
    registerComposerItem("demo", item({ label: "First" }));
    registerComposerItem("demo", item({ label: "Second" }));
    expect(allPluginComposerItems()).toHaveLength(1);
    expect(allPluginComposerItems()[0]?.label).toBe("Second");
  });

  it("falls back to the name when no label is given", () => {
    registerComposerItem("demo", item({ label: "  " }));
    expect(allPluginComposerItems()[0]?.label).toBe("demo-command");
  });

  it.each([
    ["an empty name", item({ name: "  " })],
    ["an unknown trigger", item({ trigger: "nope" as PluginComposerItem["trigger"] })],
    ["a prompt that is neither string nor function", item({ prompt: 3 as unknown as string })],
  ])("drops %s instead of throwing", (_label, bad) => {
    expect(() => registerComposerItem("demo", bad)).not.toThrow();
    expect(allPluginComposerItems()).toHaveLength(0);
  });
});

describe("pluginComposerItems", () => {
  beforeEach(() => {
    registerComposerItem("demo", item({ trigger: "command", name: "demo-command" }));
    registerComposerItem(
      "demo",
      item({ trigger: "skill", name: "demo-skill", label: "Demo Skill" }),
    );
    registerComposerItem(
      "demo",
      item({ trigger: "agent", name: "demo-agent", label: "Demo Agent" }),
    );
  });

  it("returns only the rows for the asked-for trigger", () => {
    expect(pluginComposerItems("command", "").map((row) => row.name)).toEqual(["demo-command"]);
    expect(pluginComposerItems("skill", "").map((row) => row.name)).toEqual(["demo-skill"]);
    expect(pluginComposerItems("agent", "").map((row) => row.name)).toEqual(["demo-agent"]);
  });

  it("filters case-insensitively on name OR label, like the built-in agent rows do", () => {
    expect(pluginComposerItems("skill", "demo-sk").map((row) => row.name)).toEqual(["demo-skill"]);
    expect(pluginComposerItems("skill", "DEMO SKILL").map((row) => row.name)).toEqual([
      "demo-skill",
    ]);
    expect(pluginComposerItems("skill", "Demo Sk").map((row) => row.name)).toEqual(["demo-skill"]);
    expect(pluginComposerItems("skill", "zzz")).toEqual([]);
  });
});

describe("mergePluginComposerItems", () => {
  it("PREPENDS command rows and APPENDS skill/agent rows", () => {
    registerComposerItem("demo", item({ trigger: "command" }));
    registerComposerItem("demo", item({ trigger: "skill", name: "demo-skill" }));
    expect(mergePluginComposerItems("command", "", [nativeRow]).map((row) => row.id)).toEqual([
      "plugin:demo:command:demo-command",
      "slash:model",
    ]);
    expect(mergePluginComposerItems("skill", "", [nativeRow]).map((row) => row.id)).toEqual([
      "slash:model",
      "plugin:demo:skill:demo-skill",
    ]);
  });

  it("returns the app's own rows untouched when no plugin contributed any", () => {
    expect(mergePluginComposerItems("command", "", [nativeRow])).toEqual([nativeRow]);
    expect(mergePluginComposerItems("agent", "", [])).toEqual([]);
  });

  it("applies the query filter to the plugin rows it merges", () => {
    registerComposerItem("demo", item({ trigger: "command" }));
    expect(mergePluginComposerItems("command", "zzz", [nativeRow]).map((row) => row.id)).toEqual([
      "slash:model",
    ]);
  });
});

describe("groupPluginComposerItems", () => {
  const rows = (): ComposerCommandItem[] => [...allPluginComposerItems()];

  it("puts each plugin in its OWN section, labelled with its display name", () => {
    recordPluginDisplayName("demo", "Demo");
    recordPluginDisplayName("other", "Other Plugin");
    registerComposerItem("demo", item({ name: "a" }));
    registerComposerItem("other", item({ name: "b" }));
    registerComposerItem("demo", item({ name: "c" }));
    const groups = groupPluginComposerItems(rows());
    expect(groups.map((group) => [group.id, group.label])).toEqual([
      ["plugin:demo", "Demo"],
      ["plugin:other", "Other Plugin"],
    ]);
    expect(groups[0]?.items.map((row) => (row as PluginComposerMenuItem).name)).toEqual(["a", "c"]);
  });

  it("falls back to the plugin id when no display name was recorded", () => {
    registerComposerItem("demo", item());
    expect(groupPluginComposerItems(rows())[0]?.label).toBe("demo");
  });

  it("ignores every non-plugin row (the catalog/native path is untouched)", () => {
    expect(groupPluginComposerItems([nativeRow])).toEqual([]);
  });
});

describe("ComposerCommandMenu renders a plugin section for each trigger", () => {
  const renderMenu = (
    items: ComposerCommandItem[],
    triggerKind: "slash-command" | "skill" | "subagent",
  ) =>
    renderToStaticMarkup(
      <ComposerCommandMenu
        items={items}
        resolvedTheme="light"
        isLoading={false}
        triggerKind={triggerKind}
        activeItemId={null}
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

  it("`/` — the plugin section leads, the built-in section still renders", () => {
    recordPluginDisplayName("demo", "Demo");
    registerComposerItem("demo", item({ trigger: "command", label: "/demo-command" }));
    const html = renderMenu(mergePluginComposerItems("command", "", [nativeRow]), "slash-command");
    expect(html).toContain("Demo");
    expect(html).toContain("/demo-command");
    expect(html).toContain("Built-in");
    expect(html.indexOf("Demo")).toBeLessThan(html.indexOf("Built-in"));
  });

  it("`$` — the plugin section follows the provider skills", () => {
    recordPluginDisplayName("demo", "Demo");
    registerComposerItem(
      "demo",
      item({ trigger: "skill", name: "demo-skill", label: "Demo Skill" }),
    );
    const providerSkill: ComposerCommandItem = {
      id: "skill:qwen:native",
      type: "skill",
      provider: ProviderDriverKind.make("qwen"),
      skill: { name: "native", path: "/tmp/native", scope: "user" } as never,
      label: "Native",
      description: "provider skill",
    };
    const html = renderMenu(mergePluginComposerItems("skill", "", [providerSkill]), "skill");
    expect(html).toContain("Skills");
    expect(html).toContain("Native");
    expect(html).toContain("Demo Skill");
    expect(html.indexOf("Native")).toBeLessThan(html.indexOf("Demo Skill"));
  });

  it("`#` — a plugin row shows even when the provider offers no agents at all", () => {
    recordPluginDisplayName("demo", "Demo");
    registerComposerItem(
      "demo",
      item({ trigger: "agent", name: "demo-agent", label: "Demo Agent" }),
    );
    const html = renderMenu(mergePluginComposerItems("agent", "", []), "subagent");
    expect(html).toContain("Demo");
    expect(html).toContain("Demo Agent");
  });
});

describe("resolvePluginComposerPrompt", () => {
  it("resolves a string prompt as-is", async () => {
    registerComposerItem("demo", item({ prompt: "Do the demo thing" }));
    await expect(resolvePluginComposerPrompt(allPluginComposerItems()[0]!)).resolves.toBe(
      "Do the demo thing",
    );
  });

  it("awaits an async prompt", async () => {
    registerComposerItem("demo", item({ prompt: async () => "resolved later" }));
    await expect(resolvePluginComposerPrompt(allPluginComposerItems()[0]!)).resolves.toBe(
      "resolved later",
    );
  });

  it("a rejecting resolver yields null and a toast — never an unhandled rejection", async () => {
    registerComposerItem(
      "demo",
      item({
        prompt: () => Promise.reject(new Error("no network")),
      }),
    );
    await expect(resolvePluginComposerPrompt(allPluginComposerItems()[0]!)).resolves.toBeNull();
    const problems = getPendingPluginProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.pluginId).toBe("demo");
    expect(problems[0]?.detail).toContain("no network");
  });

  it("a resolver that answers a non-string yields null", async () => {
    registerComposerItem("demo", item({ prompt: (() => Promise.resolve(7)) as never }));
    await expect(resolvePluginComposerPrompt(allPluginComposerItems()[0]!)).resolves.toBeNull();
  });
});

describe("attach / detach", () => {
  const draftId = DraftId.make("draft-plugin-test");
  const card = { id: "note-1", title: "Note #1", body: "the note body" };

  it("lands a namespaced context card on the ACTIVE draft", () => {
    recordPluginDisplayName("demo", "Demo");
    setActiveComposerTarget(draftId);
    attachPluginCard("demo", card);
    const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(draft?.reviewComments.map((comment) => comment.id)).toEqual(["plugin:demo:note-1"]);
    expect(draft?.reviewComments[0]?.filePath).toBe("Demo");
    expect(draft?.reviewComments[0]?.rangeLabel).toBe("Note #1");
    expect(draft?.reviewComments[0]?.diff).toBe("the note body");
  });

  it("detach removes exactly the card that plugin attached", () => {
    setActiveComposerTarget(draftId);
    attachPluginCard("demo", card);
    attachPluginCard("demo", { ...card, id: "note-2", title: "Note #2" });
    detachPluginCard("demo", "note-1");
    const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(draft?.reviewComments.map((comment) => comment.id)).toEqual([
      pluginCardId("demo", "note-2"),
    ]);
  });

  it("with NO active target: no throw, nothing attached, one localized info toast", () => {
    setActiveComposerTarget(null);
    expect(() => attachPluginCard("demo", card)).not.toThrow();
    expect(() => detachPluginCard("demo", "note-1")).not.toThrow();
    const problems = getPendingPluginProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("info");
    expect(problems[0]?.pluginId).toBe("demo");
    expect(problems[0]?.title.length).toBeGreaterThan(0);
  });
});

describe("pluginReviewComment", () => {
  it("fills every required ReviewCommentContext field from { id, title, body }", () => {
    recordPluginDisplayName("demo", "Demo");
    const comment = pluginReviewComment("demo", { id: "c1", title: "Card", body: "body" });
    expect(comment).toMatchObject({
      id: "plugin:demo:c1",
      sectionId: "plugin:demo",
      sectionTitle: "Demo",
      filePath: "Demo",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "Card",
      text: "Card",
      diff: "body",
      fenceLanguage: "text",
    });
  });

  it("falls back to the card id when the title is empty", () => {
    expect(pluginReviewComment("demo", { id: "c1", title: "  ", body: "" }).rangeLabel).toBe("c1");
  });
});

describe("usePluginComposerItemsRevision (A4 findings H2 + M2)", () => {
  function RevisionProbe() {
    return <span>{`rev=${usePluginComposerItemsRevision()}`}</span>;
  }

  it("changes on every registration, so ChatComposer's menu useMemo re-derives", () => {
    // Plugins register AFTER the first render now — a menu already derived from the app's own
    // sources must be re-derived when a plugin's row appears. This revision is the dependency
    // that makes that happen; a frozen value here would mean a plugin's `/` row never shows.
    expect(renderToStaticMarkup(<RevisionProbe />)).toContain("rev=0");
    registerComposerItem("demo", item());
    expect(renderToStaticMarkup(<RevisionProbe />)).toContain("rev=1");
    registerComposerItem("demo", item({ name: "second" }));
    expect(renderToStaticMarkup(<RevisionProbe />)).toContain("rev=2");
    resetPluginComposerItems();
    expect(renderToStaticMarkup(<RevisionProbe />)).toContain("rev=0");
  });
});
