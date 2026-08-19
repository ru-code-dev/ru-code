// ru-code: the `/` picker's ASSEMBLED item list — built-ins + qwen
// preconfigured commands + provider-advertised commands + search — as the one
// composite ChatComposer renders from. The pure fragments were green while
// the assembly itself had zero tests.
import { ProviderDriverKind, type ServerProviderSlashCommand } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildComposerSlashCommandMenuItems } from "../../slash-commands/composerSlashMenu";

const QWEN = ProviderDriverKind.make("qwen");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

const providerCommand = {
  name: "web",
  description: "Провайдерская команда",
} as ServerProviderSlashCommand;

describe("buildComposerSlashCommandMenuItems", () => {
  it("qwen kind, empty query: built-ins, then the four qwen commands, then provider commands", () => {
    const items = buildComposerSlashCommandMenuItems({
      selectedProvider: QWEN,
      providerSlashCommands: [providerCommand],
      query: "",
      planModeEnabled: true,
    });
    expect(items.map((item) => item.id)).toEqual([
      "slash:model",
      "slash:plan",
      "slash:default",
      "qwen-slash:init",
      "qwen-slash:summary",
      "qwen-slash:compress",
      "qwen-slash:review",
      "provider-slash-command:qwen:web",
    ]);
  });

  it("non-qwen kind: no qwen commands injected", () => {
    const items = buildComposerSlashCommandMenuItems({
      selectedProvider: CLAUDE,
      providerSlashCommands: [],
      query: "",
      planModeEnabled: true,
    });
    expect(items.map((item) => item.id)).toEqual(["slash:model", "slash:plan", "slash:default"]);
  });

  // ru-code: plan mode is a t3 setting the shared composite must gate on —
  // otherwise every build offers /plan and /default regardless of whether the
  // build even surfaces plan mode.
  it("plan mode disabled: /plan and /default are not offered", () => {
    const items = buildComposerSlashCommandMenuItems({
      selectedProvider: CLAUDE,
      providerSlashCommands: [],
      query: "",
      planModeEnabled: false,
    });
    expect(items.map((item) => item.id)).toEqual(["slash:model"]);
  });

  it("search: /compress survives a matching query, unrelated built-ins are filtered", () => {
    const items = buildComposerSlashCommandMenuItems({
      selectedProvider: QWEN,
      providerSlashCommands: [],
      query: "compress",
      planModeEnabled: true,
    });
    expect(items.map((item) => item.id)).toContain("qwen-slash:compress");
    expect(items.map((item) => item.id)).not.toContain("slash:model");
  });

  it("provider command falls back to the input hint, then to the generic description", () => {
    const withHint = {
      name: "hinted",
      input: { hint: "Подсказка" },
    } as unknown as ServerProviderSlashCommand;
    const bare = { name: "bare" } as ServerProviderSlashCommand;
    const items = buildComposerSlashCommandMenuItems({
      selectedProvider: CLAUDE,
      providerSlashCommands: [withHint, bare],
      query: "",
      planModeEnabled: true,
    });
    const descriptions = new Map(items.map((item) => [item.id, item.description]));
    expect(descriptions.get("provider-slash-command:claudeAgent:hinted")).toBe("Подсказка");
    expect(descriptions.get("provider-slash-command:claudeAgent:bare")).toBe(
      "Run provider command",
    );
  });

  it("DRAFT: /compress is offered DISABLED, every other command stays selectable", () => {
    const items = buildComposerSlashCommandMenuItems({
      selectedProvider: QWEN,
      providerSlashCommands: [providerCommand],
      query: "",
      isDraftThread: true,
      planModeEnabled: true,
    });
    const disabledById = new Map(
      items.map((item) => [item.id, "disabled" in item ? item.disabled : undefined]),
    );
    expect(disabledById.get("qwen-slash:compress")).toBe(true);
    for (const [id, disabled] of disabledById) {
      if (id === "qwen-slash:compress") continue;
      expect(disabled, id).not.toBe(true);
    }
  });

  it("existing thread (isDraftThread false/absent): /compress is NOT disabled", () => {
    for (const input of [
      { isDraftThread: false },
      {}, // absent — the historical call shape
    ]) {
      const items = buildComposerSlashCommandMenuItems({
        selectedProvider: QWEN,
        providerSlashCommands: [],
        query: "",
        planModeEnabled: true,
        ...input,
      });
      const compress = items.find((item) => item.id === "qwen-slash:compress");
      expect(compress && "disabled" in compress ? compress.disabled : undefined).not.toBe(true);
    }
  });
});
