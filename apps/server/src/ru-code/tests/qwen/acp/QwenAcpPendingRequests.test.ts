// ru-code: coverage for settleAndDelete — the held-Deferred bookkeeping the qwen
// adapter uses to park `session/request_permission` RPCs. It must resolve the
// Deferred with the caller's value AND delete the map entry (delete-at-resolve
// keeps `.size` in sync the instant the response is committed).
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { ApprovalRequestId } from "@t3tools/contracts";

import { settleAndDelete } from "@ru-code/qwen/acp/QwenAcpPendingRequests";

describe("settleAndDelete", () => {
  it.effect("resolves the deferred with the value and deletes the map entry", () =>
    Effect.gen(function* () {
      const requestId = ApprovalRequestId.make("req-1");
      const deferred = yield* Deferred.make<string>();
      const map = new Map<ApprovalRequestId, { deferred: Deferred.Deferred<string> }>();
      map.set(requestId, { deferred });

      yield* settleAndDelete({
        requestId,
        kind: "approval",
        threadId: "thread-1",
        map,
        deferred,
        value: "resolved-value",
        label: "test.respond",
      });

      const resolved = yield* Deferred.await(deferred);
      expect(resolved).toBe("resolved-value");
      expect(map.size).toBe(0);
      expect(map.has(requestId)).toBe(false);
    }),
  );

  it.effect("deletes only the target key, leaving sibling entries intact", () =>
    Effect.gen(function* () {
      const targetId = ApprovalRequestId.make("target");
      const otherId = ApprovalRequestId.make("other");
      const deferred = yield* Deferred.make<number>();
      const otherDeferred = yield* Deferred.make<number>();
      const map = new Map<ApprovalRequestId, { deferred: Deferred.Deferred<number> }>();
      map.set(targetId, { deferred });
      map.set(otherId, { deferred: otherDeferred });

      yield* settleAndDelete({
        requestId: targetId,
        kind: "plan-approval",
        threadId: "thread-1",
        map,
        deferred,
        value: 7,
        label: "test.plan",
      });

      expect(map.size).toBe(1);
      expect(map.has(otherId)).toBe(true);
      expect(map.has(targetId)).toBe(false);
    }),
  );

  it.effect("carries a structured value through to the deferred (user-input kind)", () =>
    Effect.gen(function* () {
      const requestId = ApprovalRequestId.make("q-1");
      const deferred = yield* Deferred.make<{ fruit: string }>();
      const map = new Map<ApprovalRequestId, unknown>();
      map.set(requestId, { deferred });

      yield* settleAndDelete({
        requestId,
        kind: "user-input",
        threadId: "thread-1",
        map,
        deferred,
        value: { fruit: "banana" },
        label: "test.user-input",
      });

      const answers = yield* Deferred.await(deferred);
      expect(answers).toEqual({ fruit: "banana" });
    }),
  );
});
