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
  it("qwen kind, empty query: the four qwen commands, then provider commands (built-ins hidden)", () => {
    const items = buildComposerSlashCommandMenuItems({
      selectedProvider: QWEN,
      providerSlashCommands: [providerCommand],
      query: "",
    });
    expect(items.map((item) => item.id)).toEqual([
      "qwen-slash:init",
      "qwen-slash:summary",
      "qwen-slash:compress",
      "qwen-slash:review",
      "provider-slash-command:qwen:web",
    ]);
  });

  it("non-qwen kind: no qwen commands injected (built-ins hidden → empty)", () => {
    const items = buildComposerSlashCommandMenuItems({
      selectedProvider: CLAUDE,
      providerSlashCommands: [],
      query: "",
    });
    expect(items.map((item) => item.id)).toEqual([]);
  });

  it("search: /compress survives a matching query, unrelated built-ins are filtered", () => {
    const items = buildComposerSlashCommandMenuItems({
      selectedProvider: QWEN,
      providerSlashCommands: [],
      query: "compress",
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
        ...input,
      });
      const compress = items.find((item) => item.id === "qwen-slash:compress");
      expect(compress && "disabled" in compress ? compress.disabled : undefined).not.toBe(true);
    }
  });
});
