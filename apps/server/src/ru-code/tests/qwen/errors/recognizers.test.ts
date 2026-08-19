// ru-code: 1:1 coverage of the cli-errors classifier (`recognizers.ts`). Every
// recognizer id in the routing table is exercised here as a pure `classify()`
// call — including the rows the wire fake can't induce (B3 spawn, D1/D2/D3
// server-side, E defect, unrecognized). For each row we pin the three things the
// single-writer engine downstream depends on: the recognizer `id`, the UI
// `surface` (B / T / T+N), and `killAcp`. This is the cheap, deterministic
// backstop; the end-to-end projection behaviour is covered in
// `tests/provider/cliAdapterErrorEngine.test.ts` + `errorEngineIngestion.test.ts`.
import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import {
  AcpProcessExitedError,
  AcpProtocolParseError,
  AcpRequestError,
  AcpSpawnError,
  AcpTransportError,
} from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../../../../provider/Errors.ts";
import {
  classify,
  COMPRESS_IN_PROGRESS_DETAIL,
  UNRECOGNIZED_DECISION,
} from "../../../qwen/errors/recognizers.ts";
import { Surface } from "@ru-code/qwen/errors/types";

// Map the readable surface label used in the table below to the composable
// Surface[] set the decision actually carries.
const surfaceSet = (label: "B" | "T" | "T+N"): ReadonlyArray<Surface> =>
  label === "B"
    ? [Surface.Bubble]
    : label === "T"
      ? [Surface.Timeline]
      : [Surface.Timeline, Surface.Notification];

const rpcError = (code: number, details?: string) =>
  new AcpRequestError({
    code: code as never,
    errorMessage: "rpc error",
    ...(details !== undefined ? { data: { details } } : {}),
  });

interface ClassifyExpectation {
  readonly name: string;
  readonly error: unknown;
  readonly expectedId: string; // exact id, unless `idStartsWith` is set
  readonly idStartsWith?: boolean;
  readonly surface: "B" | "T" | "T+N";
  readonly killAcp: boolean;
}

// One row per recognizer in `RECOGNIZERS` (recognizers.ts), in table order.
const RECOGNIZER_CASES: ReadonlyArray<ClassifyExpectation> = [
  {
    name: "A1 — empty model response (-32603 + empty-stream marker)",
    error: rpcError(-32603, "Model stream ended with empty response text"),
    expectedId: "A1",
    surface: "B",
    killAcp: false,
  },
  {
    name: "A2 — rate limit (429)",
    error: rpcError(429),
    expectedId: "A2",
    surface: "B",
    killAcp: false,
  },
  {
    name: "A2 — rate limit (-32603 + marker)",
    error: rpcError(-32603, "Rate limit exceeded"),
    expectedId: "A2",
    surface: "B",
    killAcp: false,
  },
  {
    name: "A7 — slash command unsupported (more specific than A3)",
    error: rpcError(-32603, "Slash command not supported in ACP"),
    expectedId: "A7",
    surface: "B",
    killAcp: false,
  },
  {
    name: "A3 — generic -32603 with usable details",
    error: rpcError(-32603, "Model unloaded."),
    expectedId: "A3",
    surface: "B",
    killAcp: false,
  },
  {
    name: "A4 — protocol invalid (-32601)",
    error: rpcError(-32601),
    expectedId: "A4",
    surface: "T",
    killAcp: false,
  },
  {
    name: "A5 — auth required (-32000)",
    error: rpcError(-32000),
    expectedId: "A5",
    surface: "T+N",
    killAcp: false,
  },
  {
    name: "A6 — resource not found (-32002)",
    error: rpcError(-32002),
    expectedId: "A6",
    surface: "T",
    killAcp: false,
  },
  {
    name: "B1 — process exited with code",
    error: new AcpProcessExitedError({ code: 1 }),
    expectedId: "B1",
    idStartsWith: true,
    surface: "T+N",
    killAcp: false,
  },
  {
    name: "B2 — process exited without code",
    error: new AcpProcessExitedError({}),
    expectedId: "B2",
    surface: "T+N",
    killAcp: false,
  },
  {
    name: "B3 — spawn failure",
    error: new AcpSpawnError({ command: "qwen --acp", cause: new Error("ENOENT") }),
    expectedId: "B3",
    surface: "T+N",
    killAcp: false,
  },
  {
    // port adapt: upstream effect-acp's AcpProtocolParseError requires `operation`
    // and has no `detail` field (an earlier variant took `{ detail }`). The C1 recognizer
    // matches by tag (Schema.is), not by payload, so the decision is unchanged.
    name: "C1 — malformed protocol frame",
    error: new AcpProtocolParseError({
      operation: "decode-wire-message",
      cause: new Error("bad json"),
    }),
    expectedId: "C1",
    surface: "T+N",
    killAcp: true,
  },
  {
    name: "C4 — transport / broken pipe",
    error: new AcpTransportError({ detail: "broken pipe", cause: new Error("EPIPE") }),
    expectedId: "C4",
    surface: "T+N",
    killAcp: true,
  },
  {
    // The sendTurn fail-fast guard while a hidden /compress runs: the exact
    // detail routes to B5 (NOT the generic Z catch-all), keeping the session
    // alive and pinning the T+N surfaces.
    name: "B5 — send during a hidden context compaction",
    error: new ProviderAdapterRequestError({
      provider: "qwen",
      method: "session/prompt",
      detail: COMPRESS_IN_PROGRESS_DETAIL,
    }),
    expectedId: "B5",
    surface: "T+N",
    killAcp: false,
  },
  {
    name: "D2 — adapter session not found (before D1/D3)",
    error: new ProviderAdapterSessionNotFoundError({ provider: "qwen", threadId: "thread-1" }),
    expectedId: "D2",
    surface: "T",
    killAcp: false,
  },
  {
    name: "D1 — adapter input validation",
    error: new ProviderAdapterValidationError({
      provider: "qwen",
      operation: "sendTurn",
      issue: "empty",
    }),
    expectedId: "D1",
    surface: "T",
    killAcp: true,
  },
  {
    name: "D3 — other Provider*-tagged error",
    error: { _tag: "ProviderSomethingElseError", message: "x" },
    expectedId: "D3",
    surface: "T",
    killAcp: true,
  },
  {
    name: "Z — clean ProviderAdapterRequestError with detail (runs last)",
    error: new ProviderAdapterRequestError({
      provider: "qwen",
      method: "session/prompt",
      detail: "Понятная ошибка из движка",
    }),
    expectedId: "request-error",
    surface: "T+N",
    killAcp: false,
  },
];

describe("cli-errors classify() — full recognizer table", () => {
  RECOGNIZER_CASES.forEach((testCase) => {
    it(testCase.name, () => {
      const decision = classify(testCase.error, Cause.fail(testCase.error));
      expect(decision).not.toBeNull();
      if (testCase.idStartsWith) {
        expect(decision!.id.startsWith(testCase.expectedId)).toBe(true);
      } else {
        expect(decision!.id).toBe(testCase.expectedId);
      }
      expect(decision!.surface).toEqual(surfaceSet(testCase.surface));
      expect(decision!.killAcp ?? false).toBe(testCase.killAcp);
      // Every surfaced decision must carry non-empty UI text.
      expect((decision!.text ?? "").length).toBeGreaterThan(0);
    });
  });

  it("E — synchronous defect (Cause.die) → E, surface T, killAcp", () => {
    const decision = classify(undefined, Cause.die(new Error("synchronous throw")));
    expect(decision?.id).toBe("E");
    expect(decision?.surface).toEqual([Surface.Timeline]);
    expect(decision?.killAcp).toBe(true);
  });

  it("unrecognized — a plain Error matches nothing → classify null → UNRECOGNIZED_DECISION", () => {
    const plainError = new Error("mystery failure with no recognizer");
    expect(classify(plainError, Cause.fail(plainError))).toBeNull();
    expect(UNRECOGNIZED_DECISION.id).toBe("unrecognized");
    expect(UNRECOGNIZED_DECISION.surface).toEqual([Surface.Timeline, Surface.Notification]);
  });

  it("wrapped error — A5 matches through a mapAcpToAdapterError-style .cause", () => {
    // The finalizer/reactor classify the MAPPED error, not the bare AcpRequestError.
    const wrapped = new ProviderAdapterRequestError({
      provider: "qwen",
      method: "session/prompt",
      detail: "auth",
      cause: rpcError(-32000),
    });
    const decision = classify(wrapped, Cause.fail(wrapped));
    expect(decision?.id).toBe("A5"); // resolved via the inner cause, not Z
    expect(decision?.surface).toEqual([Surface.Timeline, Surface.Notification]);
  });
});

// ru-code: A7's slash-unsupported bubble names the CONTEXT file, which is the active
// profile's artifact id (`${artifact}.md`). classify() threads it so a fork instance
// shows its own file, stock qwen shows QWEN.md, and the default stays CUSTOM_CODE.
describe("cli-errors classify() — per-profile artifact in the A7 CONTEXT hint", () => {
  const slashError = rpcError(-32603, "Slash command not supported in ACP");

  it("threads an explicit artifact into the A7 text", () => {
    const qwen = classify(slashError, Cause.fail(slashError), "QWEN");
    expect(qwen?.id).toBe("A7");
    expect(qwen?.text).toContain("QWEN.md");
    expect(qwen?.text).not.toContain("CUSTOM_CODE.md");

    const fork = classify(slashError, Cause.fail(slashError), "CUSTOM_CODE");
    expect(fork?.text).toContain("CUSTOM_CODE.md");
    expect(fork?.text).not.toContain("QWEN.md");
  });

  it("defaults to the boot profile's artifact (CUSTOM_CODE) when none is passed", () => {
    const decision = classify(slashError, Cause.fail(slashError));
    expect(decision?.id).toBe("A7");
    expect(decision?.text).toContain("CUSTOM_CODE.md");
  });
});
