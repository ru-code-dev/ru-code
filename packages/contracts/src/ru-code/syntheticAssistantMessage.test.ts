// ru-code: the synthetic-id classifier is exact-shape (`assistant:<uuid>`), not
// prefix — REAL assistant message ids start with `assistant:` too (ingestion
// mints `assistant:${providerItemId}`, and qwen item ids themselves start with
// `assistant:`). The prefix version classified every real qwen message id as
// synthetic, which is exactly how the diff chip detached in chat.
import { describe, expect, it } from "vite-plus/test";

import {
  isSyntheticAssistantMessageId,
  syntheticAssistantMessageId,
} from "./syntheticAssistantMessage.ts";

const TURN_UUID = "8e10f236-d7a8-4076-9782-6dcb33be3a00";

describe("isSyntheticAssistantMessageId", () => {
  it("classifies the reactor/ingestion mints from a UUID source as synthetic", () => {
    expect(isSyntheticAssistantMessageId(syntheticAssistantMessageId(TURN_UUID))).toBe(true);
    expect(isSyntheticAssistantMessageId(`assistant:${TURN_UUID}`)).toBe(true);
  });

  it("classifies REAL qwen message ids as real (the shipped bug)", () => {
    // ingestion `assistant:` + qwen item id `assistant:<sessionId>:r<nonce>:segment:N`
    expect(
      isSyntheticAssistantMessageId(
        "assistant:assistant:9169ba0d-07ac-473e-9195-25728b8743ee:rfbf8c311:segment:0",
      ),
    ).toBe(false);
  });

  it("classifies other real provider item shapes as real", () => {
    expect(isSyntheticAssistantMessageId("assistant:item_0")).toBe(false);
    expect(isSyntheticAssistantMessageId("assistant:msg-42:segment:1")).toBe(false);
    expect(isSyntheticAssistantMessageId("some-plain-id")).toBe(false);
  });

  it("treats null/undefined as not synthetic", () => {
    expect(isSyntheticAssistantMessageId(null)).toBe(false);
    expect(isSyntheticAssistantMessageId(undefined)).toBe(false);
  });

  it("a placeholder minted from a PRESENT provider itemId equals the real id and classifies real", () => {
    // ProviderRuntimeIngestion's turn.diff.updated placeholder path mints from
    // `itemId ?? turnId ?? eventId`; with an itemId present the mint PREDICTS
    // the real message id — it must not be treated as unresolved.
    const qwenItemId = "assistant:9169ba0d-07ac-473e-9195-25728b8743ee:rfbf8c311:segment:0";
    expect(isSyntheticAssistantMessageId(syntheticAssistantMessageId(qwenItemId))).toBe(false);
  });
});
