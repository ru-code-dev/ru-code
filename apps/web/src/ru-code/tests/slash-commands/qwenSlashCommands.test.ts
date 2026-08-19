// ru-code: the composer's qwen slash-command surface — the WHOLE picker
// decision (kind gate + item shape) and the WHOLE submit guard (pass / strip /
// abort). qwen answers any out-of-allowlist built-in /command with a raw
// -32603 (Session.ts:1057-1061), so a hole in the guard is a user-visible
// protocol error; a hole in the gate leaks qwen commands into Claude threads.
import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import { QWEN_KIND } from "@ru-code/branding";

import {
  buildQwenSlashCommandItems,
  KNOWN_QWEN_SLASH_COMMAND_SLUGS,
  QWEN_SLASH_COMMANDS,
  resolveQwenSubmitPrompt,
  stripUnknownLeadingSlashCommand,
} from "../../slash-commands/qwenSlashCommands";

const QWEN_DRIVER_KIND = ProviderDriverKind.make(QWEN_KIND);
const OTHER_KIND = ProviderDriverKind.make("claudeAgent");

describe("buildQwenSlashCommandItems — the picker decision", () => {
  it("offers exactly the four preconfigured commands for the CLI kind", () => {
    const items = buildQwenSlashCommandItems(QWEN_DRIVER_KIND);
    expect(items.map((item) => item.label)).toEqual(["/init", "/summary", "/compress", "/review"]);
    // The items ride the existing provider-slash-command variant so selection
    // (insert `/name ` + Enter) needs no new composer code paths.
    expect(items.every((item) => item.type === "provider-slash-command")).toBe(true);
    expect(items.every((item) => item.provider === QWEN_DRIVER_KIND)).toBe(true);
    // Descriptions are owned locally.
    expect(items[2]?.description).toBe("Compact the conversation history to save context");
  });

  it("offers NOTHING for non-CLI kinds (no leak into other providers)", () => {
    expect(buildQwenSlashCommandItems(OTHER_KIND)).toEqual([]);
  });
});

describe("stripUnknownLeadingSlashCommand — the submit guard", () => {
  it("passes every known slug verbatim (picker commands + allowed built-ins + app commands)", () => {
    for (const command of QWEN_SLASH_COMMANDS) {
      expect(stripUnknownLeadingSlashCommand(`/${command.name}`)).toBe(`/${command.name}`);
    }
    expect(stripUnknownLeadingSlashCommand("/compress please")).toBe("/compress please");
    expect(stripUnknownLeadingSlashCommand("/review 42")).toBe("/review 42");
    expect(stripUnknownLeadingSlashCommand("/btw nice")).toBe("/btw nice");
    expect(stripUnknownLeadingSlashCommand("/plan")).toBe("/plan");
    // Case-insensitive matching.
    expect(stripUnknownLeadingSlashCommand("/COMPRESS")).toBe("/COMPRESS");
  });

  it("passes ordinary text untouched (including mid-text slashes)", () => {
    expect(stripUnknownLeadingSlashCommand("привет, поправь src/main.ts")).toBe(
      "привет, поправь src/main.ts",
    );
    expect(stripUnknownLeadingSlashCommand("")).toBe("");
  });

  it("strips an unknown leading /command, keeping the trailing text", () => {
    expect(stripUnknownLeadingSlashCommand("/clear и продолжай")).toBe("и продолжай");
    expect(stripUnknownLeadingSlashCommand("  /mcp покажи список  ")).toBe("покажи список");
  });

  it("returns null for a BARE unknown command — the caller must abort the submit", () => {
    expect(stripUnknownLeadingSlashCommand("/clear")).toBeNull();
    expect(stripUnknownLeadingSlashCommand("/help")).toBeNull();
    expect(stripUnknownLeadingSlashCommand("   /agents   ")).toBeNull();
  });

  it("leading whitespace cannot smuggle a command past the check", () => {
    expect(stripUnknownLeadingSlashCommand("   /unknown do it")).toBe("do it");
  });

  it("the known-slug set contains no surprises", () => {
    expect([...KNOWN_QWEN_SLASH_COMMAND_SLUGS].toSorted()).toEqual(
      [
        "btw",
        "bug",
        "compress",
        "default",
        "init",
        "model",
        "plan",
        "review",
        "summary",
      ].toSorted(),
    );
  });
});

describe("stripUnknownLeadingSlashCommand — dynamic catalog command allowlist", () => {
  const slugs: ReadonlySet<string> = new Set(["mycommand", "deploy"]);

  it("a catalog command in the live set passes verbatim (bare and with args)", () => {
    expect(stripUnknownLeadingSlashCommand("/mycommand", slugs)).toBe("/mycommand");
    expect(stripUnknownLeadingSlashCommand("/deploy prod", slugs)).toBe("/deploy prod");
  });

  it("matches the catalog set case-insensitively", () => {
    expect(stripUnknownLeadingSlashCommand("/MyCommand", slugs)).toBe("/MyCommand");
  });

  it("a command NOT in the set is still unknown (bare → null, args → stripped)", () => {
    expect(stripUnknownLeadingSlashCommand("/other", slugs)).toBeNull();
    expect(stripUnknownLeadingSlashCommand("/other do it", slugs)).toBe("do it");
  });

  it("dynamic: the same command flips null → pass as the set gains it", () => {
    expect(stripUnknownLeadingSlashCommand("/mycommand")).toBeNull(); // no set (pre-connect)
    expect(stripUnknownLeadingSlashCommand("/mycommand", new Set())).toBeNull(); // empty set
    expect(stripUnknownLeadingSlashCommand("/mycommand", slugs)).toBe("/mycommand"); // connected
  });

  it("built-in slugs still pass even with an empty catalog set", () => {
    expect(stripUnknownLeadingSlashCommand("/init", new Set())).toBe("/init");
  });
});

describe("resolveQwenSubmitPrompt — the submit composite", () => {
  const QWEN = QWEN_DRIVER_KIND;
  const OTHER = ProviderDriverKind.make("codex");

  it("a BARE /compress routes to the hidden compaction flow (the meter-button path)", () => {
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "/compress",
        hasNonTextContent: false,
      }),
    ).toEqual({ action: "compact" });
    // whitespace + case cannot dodge the reroute
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "  /Compress  ",
        hasNonTextContent: false,
      }),
    ).toEqual({ action: "compact" });
  });

  it("/compress with trailing text or attachments keeps the regular send path", () => {
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "/compress please",
        hasNonTextContent: false,
      }),
    ).toEqual({ action: "send", prompt: "/compress please" });
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "/compress",
        hasNonTextContent: true,
      }),
    ).toEqual({ action: "send", prompt: "/compress" });
  });

  it("non-qwen kinds pass verbatim — /compress included", () => {
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: OTHER,
        prompt: "/compress",
        hasNonTextContent: false,
      }),
    ).toEqual({ action: "send", prompt: "/compress" });
  });

  it("the unknown-slug guard is unchanged: bare unknown aborts, attachments rescue", () => {
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "/help",
        hasNonTextContent: false,
      }),
    ).toEqual({ action: "abort" });
    expect(
      resolveQwenSubmitPrompt({ selectedProvider: QWEN, prompt: "/help", hasNonTextContent: true }),
    ).toEqual({ action: "send", prompt: "" });
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "привет",
        hasNonTextContent: false,
      }),
    ).toEqual({ action: "send", prompt: "привет" });
  });
});
