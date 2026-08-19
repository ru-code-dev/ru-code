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
