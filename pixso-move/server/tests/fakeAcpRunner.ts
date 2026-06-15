import { AcpRunner } from "@pixso-move/processor";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const FAKE_ACP_TEXT = "<html><!-- fake --></html>";

// A scripted ACP runner for tests — returns fixed text instead of spawning qwen.
export const FakeAcpRunnerLive = Layer.succeed(AcpRunner, {
  run: () => Effect.succeed({ text: FAKE_ACP_TEXT, stopReason: "end_turn" }),
});
