// ru-code: the `plugin-item` INSERT contract (mvp-plan D7, §6 risk 2).
//
// `ChatComposer`'s insert switch is one branch inside a 3500-line component with no exported
// seam, so what is pinned here is the CONTRACT the branch is written against — the
// `applyPromptReplacement` `expectedText` guard, reproduced from `ChatComposer.tsx:1750-1766`
// (the whole guard is those four lines: compare the live text in the range against the text
// that was there when the row was selected, and refuse if it moved). The branch body itself is
// exercised in the browser by A9's drop-in run; this suite proves the three outcomes it can
// have, driven by the REAL `resolvePluginComposerPrompt`.
//
// The property that matters: an async prompt that resolves after the reader kept typing must
// be a silent NO-OP — never a throw, never a duplicate insert, never text spliced at a range
// that has moved.

import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  allPluginComposerItems,
  registerComposerItem,
  resetPluginComposerItems,
  resolvePluginComposerPrompt,
  type PluginComposerMenuItem,
} from "./composerRegistry";
import { toProviderMenuItem } from "./composerProviders";
import { resetPluginProblems } from "./problems";

/** A composer whose text can change under an in-flight prompt. */
function makeComposer(initial: string) {
  // ru-code (A22): `lastExpectedText` records what the guard was handed, so a test can assert the
  // guard was ENGAGED without having to make it fire.
  const state = {
    text: initial,
    applied: 0,
    refused: 0,
    lastExpectedText: undefined as string | undefined,
  };
  /** Verbatim contract of `ChatComposer.tsx`'s `applyPromptReplacement` guard + splice. */
  const applyPromptReplacement = (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options?: { expectedText?: string },
  ): boolean => {
    const currentText = state.text;
    state.lastExpectedText = options?.expectedText;
    const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
    const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
    if (
      options?.expectedText !== undefined &&
      currentText.slice(safeStart, safeEnd) !== options.expectedText
    ) {
      state.refused += 1;
      return false;
    }
    state.text = currentText.slice(0, rangeStart) + replacement + currentText.slice(rangeEnd);
    state.applied += 1;
    return true;
  };
  return { state, applyPromptReplacement };
}

/** The `plugin-item` branch of the insert switch, as ChatComposer runs it. */
function selectPluginItem(
  composer: ReturnType<typeof makeComposer>,
  item: PluginComposerMenuItem,
  trigger: { rangeStart: number; rangeEnd: number },
): Promise<void> {
  // The snapshot is taken at SELECT time — that is exactly why the guard is needed.
  const snapshotValue = composer.state.text;
  const insertPluginPrompt = (prompt: string) => {
    // ru-code (A22): who owns the trailing space. A `registerItem` row's `prompt` gets the
    // documented `prompt + " "`; a PROVIDER row's `insert` is pasted verbatim, because the SDK
    // promises "the host inserts it verbatim" and a catalog token already carries its own space.
    const replacement = item.insertVerbatim === true ? prompt : `${prompt} `;
    composer.applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, replacement, {
      expectedText: snapshotValue.slice(trigger.rangeStart, trigger.rangeEnd),
    });
  };
  if (typeof item.prompt === "string") {
    insertPluginPrompt(item.prompt);
    return Promise.resolve();
  }
  return resolvePluginComposerPrompt(item).then((prompt) => {
    if (prompt !== null) insertPluginPrompt(prompt);
  });
}

const only = (): PluginComposerMenuItem => {
  const item = allPluginComposerItems()[0];
  if (item === undefined) throw new Error("nothing registered");
  return item;
};

beforeEach(() => {
  resetPluginComposerItems();
  resetPluginProblems();
});

describe("a string prompt", () => {
  it('replaces the trigger with `prompt + " "`, synchronously', async () => {
    registerComposerItem("demo", {
      trigger: "command",
      name: "demo-command",
      label: "/demo-command",
      description: "",
      prompt: "Review this diff",
    });
    const composer = makeComposer("/demo");
    await selectPluginItem(composer, only(), { rangeStart: 0, rangeEnd: 5 });
    expect(composer.state.text).toBe("Review this diff ");
    expect(composer.state.applied).toBe(1);
    expect(composer.state.refused).toBe(0);
  });
});

describe("an async prompt", () => {
  const registerAsync = (resolve: () => Promise<string>) =>
    registerComposerItem("demo", {
      trigger: "command",
      name: "demo-command",
      label: "/demo-command",
      description: "",
      prompt: resolve,
    });

  it("inserts once when the composer text did not move while it resolved", async () => {
    registerAsync(async () => "Late prompt");
    const composer = makeComposer("/demo");
    await selectPluginItem(composer, only(), { rangeStart: 0, rangeEnd: 5 });
    expect(composer.state.text).toBe("Late prompt ");
    expect(composer.state.applied).toBe(1);
  });

  const pendingPrompt = () => {
    let release: (value: string) => void = () => {};
    registerAsync(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    return { release: (value: string) => release(value) };
  };

  it("is a NO-OP when the composer was cleared while it resolved — refused, no throw", async () => {
    const { release } = pendingPrompt();
    const composer = makeComposer("/demo");
    const pending = selectPluginItem(composer, only(), { rangeStart: 0, rangeEnd: 5 });
    // …the reader cleared the composer (or switched thread) before the prompt landed.
    composer.state.text = "something else entirely";
    release("Late prompt");
    await expect(pending).resolves.toBeUndefined();
    expect(composer.state.text).toBe("something else entirely");
    expect(composer.state.applied).toBe(0);
    expect(composer.state.refused).toBe(1);
  });

  it("is a NO-OP when the trigger MOVED while it resolved — refused, no duplicate", async () => {
    const { release } = pendingPrompt();
    const composer = makeComposer("/demo");
    const pending = selectPluginItem(composer, only(), { rangeStart: 0, rangeEnd: 5 });
    // …text typed BEFORE the trigger shifts the range the insert was aimed at.
    composer.state.text = `hello ${composer.state.text}`;
    release("Late prompt");
    await expect(pending).resolves.toBeUndefined();
    expect(composer.state.text).toBe("hello /demo");
    expect(composer.state.applied).toBe(0);
    expect(composer.state.refused).toBe(1);
  });

  it("still applies when only text AFTER the trigger changed — the guard is a RANGE check", async () => {
    // Documented, not accidental: `expectedText` compares the trigger's own slice, exactly as
    // every other branch of the insert switch does. Typing past the trigger does not
    // invalidate it, and the resulting insert is the one the reader asked for.
    const { release } = pendingPrompt();
    const composer = makeComposer("/demo");
    const pending = selectPluginItem(composer, only(), { rangeStart: 0, rangeEnd: 5 });
    composer.state.text = "/demo and then some";
    release("Late prompt");
    await pending;
    expect(composer.state.text).toBe("Late prompt  and then some");
    expect(composer.state.applied).toBe(1);
  });

  it("is a NO-OP when the resolver rejects — no throw, no insert", async () => {
    registerAsync(() => Promise.reject(new Error("offline")));
    const composer = makeComposer("/demo");
    await expect(
      selectPluginItem(composer, only(), { rangeStart: 0, rangeEnd: 5 }),
    ).resolves.toBeUndefined();
    expect(composer.state.text).toBe("/demo");
    expect(composer.state.applied).toBe(0);
    expect(composer.state.refused).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ru-code (A22, SDK 0.3.0, A23 finding): a PROVIDER row's `insert` is pasted VERBATIM
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The two mechanisms space themselves differently and both are right:
//
//   * `registerItem({ prompt })` is a PROMPT — a sentence the reader will keep typing after — and
//     the host has always appended a space. Every plugin shipped so far relies on it;
//   * `registerProvider(...)`'s `insert` is "the exact text pasted". A catalog chip is
//     `skill:⟦auth⟧ ` (its own trailing space, because the token has to close before the next
//     word) and a custom command is `/name `; only the plugin knows which. A host that appended a
//     second space produced `skill:⟦auth⟧  `, which A23 hit on the first real provider.
//
// The rule therefore travels WITH the row (`insertVerbatim`), not with the trigger.

describe("a provider row's insert (A22)", () => {
  it("is pasted byte for byte — the host adds no second space", () => {
    const composer = makeComposer("$au");
    const item = toProviderMenuItem("catalogs", "skill", {
      name: "auth",
      label: "auth",
      description: "",
      insert: "skill:\u27e6auth\u27e7 ",
    });
    if (item === null) throw new Error("row was rejected");

    void selectPluginItem(composer, item, { rangeStart: 0, rangeEnd: 3 });
    expect(composer.state.text).toBe("skill:\u27e6auth\u27e7 ");
    // Not `skill:⟦auth⟧  ` — one space, the one the plugin wrote.
    expect(composer.state.text.endsWith("  ")).toBe(false);
    expect(composer.state.applied).toBe(1);
  });

  it("pastes a command row with no trailing space when the plugin asked for none", () => {
    const composer = makeComposer("/my");
    const item = toProviderMenuItem("catalogs", "command", {
      name: "mycommand",
      label: "/mycommand",
      description: "",
      insert: "/mycommand",
    });
    if (item === null) throw new Error("row was rejected");

    void selectPluginItem(composer, item, { rangeStart: 0, rangeEnd: 3 });
    expect(composer.state.text).toBe("/mycommand");
  });

  it("still rides the SAME expectedText guard as every other row", () => {
    // The guard is what makes the whole seam safe (a row selected against text the reader has
    // since changed writes nothing — the async cases above drive that end to end), and the
    // verbatim path must not weaken it: it goes through the identical call, with the identical
    // `expectedText` taken from the select-time snapshot.
    const composer = makeComposer("$au");
    const item = toProviderMenuItem("catalogs", "skill", {
      name: "auth",
      label: "auth",
      description: "",
      insert: "skill:\u27e6auth\u27e7 ",
    });
    if (item === null) throw new Error("row was rejected");

    void selectPluginItem(composer, item, { rangeStart: 0, rangeEnd: 3 });
    expect(composer.state.lastExpectedText).toBe("$au");
    expect(composer.state.applied).toBe(1);

    // …and the same row against a range that has MOVED is refused, not spliced at the old offsets.
    const moved = makeComposer("$au");
    moved.state.text = "hello world";
    moved.applyPromptReplacement(0, 3, "skill:\u27e6auth\u27e7 ", { expectedText: "$au" });
    expect(moved.state.text).toBe("hello world");
    expect(moved.state.refused).toBe(1);
  });
});
