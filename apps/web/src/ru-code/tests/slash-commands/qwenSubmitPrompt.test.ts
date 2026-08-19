// ru-code: the WHOLE submit decision ChatView.onSend applies for qwen-kind
// threads (pass / strip / abort / attachments-only), as the wired composite.
// The strip function alone was green while its onSend wiring had zero tests.
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveQwenSubmitPrompt } from "../../slash-commands/qwenSlashCommands";

const QWEN = ProviderDriverKind.make("qwen");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

describe("resolveQwenSubmitPrompt", () => {
  it("non-qwen kind passes any prompt verbatim, even unknown /commands", () => {
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: CLAUDE,
        prompt: "/clear",
        hasNonTextContent: false,
      }),
    ).toEqual({ action: "send", prompt: "/clear" });
  });

  it("qwen: plain text passes verbatim", () => {
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "привет",
        hasNonTextContent: false,
      }),
    ).toEqual({ action: "send", prompt: "привет" });
  });

  it("qwen: known slugs pass verbatim (picker commands AND the app's own /plan)", () => {
    for (const prompt of ["/init", "/plan", "/model", "/default"]) {
      expect(
        resolveQwenSubmitPrompt({ selectedProvider: QWEN, prompt, hasNonTextContent: false }),
      ).toEqual({ action: "send", prompt });
    }
    // A bare /compress no longer sends — it routes to the hidden compaction
    // flow (the meter-button path). Full contract in qwenSlashCommands.test.ts.
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "/compress",
        hasNonTextContent: false,
      }),
    ).toEqual({ action: "compact" });
  });

  it("qwen: unknown slug with trailing text is stripped to the text", () => {
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "/clear и продолжай",
        hasNonTextContent: false,
      }),
    ).toEqual({ action: "send", prompt: "и продолжай" });
  });

  it("qwen: bare unknown slug aborts the submit (composer keeps the text)", () => {
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "/clear",
        hasNonTextContent: false,
      }),
    ).toEqual({ action: "abort" });
  });

  it("qwen: bare unknown slug WITH attachments sends the attachments alone", () => {
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "/clear",
        hasNonTextContent: true,
      }),
    ).toEqual({ action: "send", prompt: "" });
  });
});

// ru-code: the catalog custom-command allowlist is DYNAMIC — commands are added/removed/connected in
// the Commands panel, so the guard consults the live set the caller passes (useCatalogCommandSlugs).
describe("resolveQwenSubmitPrompt — dynamic catalog command allowlist", () => {
  const slugs: ReadonlySet<string> = new Set(["mycommand", "fs:ls"]);

  it("qwen: a bare catalog command is RECOGNIZED and sent, not aborted", () => {
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "/mycommand",
        hasNonTextContent: false,
        catalogCommandSlugs: slugs,
      }),
    ).toEqual({ action: "send", prompt: "/mycommand" });
  });

  it("qwen: catalog command match is case-insensitive and keeps trailing args", () => {
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "/MyCommand arg1 arg2",
        hasNonTextContent: false,
        catalogCommandSlugs: slugs,
      }),
    ).toEqual({ action: "send", prompt: "/MyCommand arg1 arg2" });
  });

  it("qwen: DYNAMIC — the same command aborts once it is gone from the set (removed/disconnected)", () => {
    // empty set — every command disconnected
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "/mycommand",
        hasNonTextContent: false,
        catalogCommandSlugs: new Set(),
      }),
    ).toEqual({ action: "abort" });
    // no set passed at all — the pre-fix / non-catalog path
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "/mycommand",
        hasNonTextContent: false,
      }),
    ).toEqual({ action: "abort" });
  });

  it("qwen: a truly unknown command still aborts even when a catalog set is present", () => {
    expect(
      resolveQwenSubmitPrompt({
        selectedProvider: QWEN,
        prompt: "/clear",
        hasNonTextContent: false,
        catalogCommandSlugs: slugs,
      }),
    ).toEqual({ action: "abort" });
  });
});
