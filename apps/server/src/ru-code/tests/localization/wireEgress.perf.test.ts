// ru-code: MEASURED cost of the WS egress-localization wrapper — the hot path every
// outgoing socket message crosses. Two claims, each asserted against a budget generous
// enough for a loaded CI host but tight enough to catch a real regression (an accidental
// deep walk / parse on the fast path would blow these by orders of magnitude):
//
//   1. TOKEN-FREE messages (≈all traffic: terminal output, file trees, diffs, model
//      deltas) pay ONE native `String.includes` scan on the already-produced JSON — no
//      parse, no walk, no allocation. Overhead over raw JSON.stringify must be small even
//      on a ~1 MB message.
//   2. TOKEN-BEARING messages (rare: a compaction/error row among a full snapshot) pay
//      parse → resolveDeep → re-stringify ONCE, still far under a frame.
//
// Budgets are absolute per-message costs measured over many iterations, plus a ratio
// bound on the fast path — the property that actually matters ("wrapping layerJson does
// not meaningfully slow the wire").
import { describe, expect, it } from "@effect/vitest";
import { Lc } from "@ru-code/localization";

import { localizedJsonSerialization } from "../../localization/wireEgress.ts";

const parser = localizedJsonSerialization.makeUnsafe();

// A realistic large thread-detail-snapshot-shaped message, ~tokenFree ? no Lc : one Lc
// row among plain ones. `size` scales the activity count.
function makeSnapshotMessage(size: number, withToken: boolean) {
  const activities = Array.from({ length: size }, (_ignored, i) => ({
    id: `evt-${i}`,
    tone: "info",
    kind: "task.completed",
    summary: `Ran command ${i} — output captured (${i * 37} bytes), exit code 0`,
    payload: {
      taskId: `task-${i}`,
      status: "completed",
      detail: `step ${i}: files touched src/a${i}.ts, src/b${i}.ts; no conflicts detected`,
      usage: { preTokens: 1000 + i, postTokens: 900 + i },
    },
    turnId: null,
    createdAt: "2026-05-01T00:00:00.000Z",
  }));
  if (withToken) {
    activities[Math.floor(size / 2)] = {
      ...activities[Math.floor(size / 2)]!,
      summary: Lc(
        "Compaction succeeded {0}.",
        "Сжатие выполнено успешно {0}.",
        "(200000 -> 12345)",
      ),
    };
  }
  return { _tag: "Exit", value: { thread: { id: "t-1", activities } } };
}

const median = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

function measure(run: () => void, iterations: number): number {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    run();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

describe("egress wrapper — measured cost", () => {
  it("token-free fast path: one includes() scan, near-zero overhead over raw JSON.stringify", () => {
    const message = makeSnapshotMessage(2000, false); // ≈1 MB encoded
    const encodedSize = String(parser.encode(message)).length;

    // Warm up both paths, then take medians over enough iterations to be stable.
    const rawMs = measure(() => void JSON.stringify(message), 30);
    const wrappedMs = measure(() => void parser.encode(message), 30);
    const overheadMs = Math.max(0, wrappedMs - rawMs);

    // A ~1 MB token-free message: the wrapper may add only the includes() scan. Budgets:
    // absolute overhead well under a millisecond per message (typical: ~0.05–0.2 ms), and
    // never more than the stringify itself (ratio ≤ 2× guards against an accidental
    // parse/walk on the fast path, which would be ≥ 3× immediately).
    expect(encodedSize).toBeGreaterThan(500_000);
    expect(overheadMs).toBeLessThan(1.5);
    expect(wrappedMs).toBeLessThan(rawMs * 2 + 0.5);
  });

  it("token-free SMALL message (the per-delta hot path): sub-0.05ms per message", () => {
    const message = {
      _tag: "Chunk",
      values: [{ kind: "content.delta", text: "assistant token stream chunk, plain text" }],
    };
    // Median over many runs; a per-delta cost above 0.05 ms would be a real wire slowdown.
    const perMessageMs =
      measure(() => {
        for (let i = 0; i < 100; i++) parser.encode(message);
      }, 30) / 100;
    expect(perMessageMs).toBeLessThan(0.05);
  });

  it("token-bearing message: parse → resolve → re-stringify still far under a frame", () => {
    const message = makeSnapshotMessage(2000, true); // ~1 MB with ONE token row
    const wrappedMs = measure(() => void parser.encode(message), 15);
    // Full parse + deep resolve + re-stringify of ~1 MB. Typical: single-digit ms; the
    // 60 fps frame budget is ~16 ms — allow 3 frames for a loaded CI host. This message
    // shape (a full snapshot with a token) happens once per thread load, not per delta.
    expect(wrappedMs).toBeLessThan(50);
    // And it actually resolved: no sentinel escape survives in the output.
    expect(String(parser.encode(message))).not.toContain("\\u001e");
  });
});
