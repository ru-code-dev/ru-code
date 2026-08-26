// ru-code (agentic-flow wave, timer-bug): THE VANISHING WORKING ROW — regression guard.
//
// THE INVARIANT THIS GUARDS (user-visible, DOM-only):
//   While the composer offers "Stop generation" — i.e. the app is visibly
//   generating — the timeline MUST carry the working row
//   (`[data-timeline-row-id="working-indicator-row"]`, stamped in
//   MessagesTimeline.tsx). A sustained window where the Stop button is offered
//   and the working row is absent from the DOM is the defect.
//
// THE DEFECT IT WAS BORN ON: a commit that SHRINKS the timeline row array while
// a virtualised @legendapp/list container holds a row whose stale `indexByKey`
// entry lands past the new end blanks that row permanently — `getRenderedItem`
// returns `renderedItem: null` and the Container's `useMemo` caches that null
// with nothing able to invalidate it. Our stop-with-running-fleet → next-send
// sequence is the reliable way the chat produces such a tail shrink (the stopped
// turn folds the instant the next turn's id arrives). Mechanism dossier:
// WORKFLOW/waves/agentic-flow/timer-bug-report.md.
//
// ORACLE — deliberately DOM-ONLY. An earlier form of this spec read a temporary
// `[timer-log]` console instrument for the DATA side; those diagnostics have been
// removed from the app, and a guard that depends on console logging is a guard
// that rots. Everything below is sampled from the rendered document: the Stop
// button (aria-label, EN or RU), the working row's `data-timeline-row-id`, the
// rendered row count and the timeline scroller's geometry.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Page } from "@playwright/test";

import { openThread, readHarnessState, sendPrompt, test, writeFakeControl } from "./fixtures.ts";

/** One 100 ms DOM sample. Every field is read out of the rendered document. */
interface DomSample {
  readonly t: number;
  /** The working row is in the DOM. */
  readonly dom: boolean;
  /** `[data-timeline-row-id]` elements currently rendered. */
  readonly rendered: number;
  /** The composer is offering "Stop generation" — the app is visibly generating. */
  readonly stop: boolean;
  /** Timeline scroller distance from the bottom, or null when no scroller resolved. */
  readonly dfb: number | null;
}

const DOM_KEY = "__ruCodeWorkingDom";

/**
 * The oracle, installed in-page. `sessionStorage` (not a module global) because
 * the SPA's route change can outlive a bare `evaluate` install — the pattern
 * workingIndicator.e2e.test.ts already had to learn. Armed BOTH as an init
 * script and directly, so an already-loaded document is covered too.
 */
const DOM_SAMPLER = () => {
  const KEY = "__ruCodeWorkingDom";
  const scope = globalThis as unknown as { __domArmed?: boolean };
  if (scope.__domArmed === true) return;
  scope.__domArmed = true;
  window.setInterval(() => {
    let buffer: unknown[] = [];
    try {
      buffer = JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as unknown[];
    } catch {
      buffer = [];
    }
    const stop = Array.from(document.querySelectorAll("button")).some((button) =>
      /Stop generation|Остановить генерацию/.test(button.getAttribute("aria-label") ?? ""),
    );
    const renderedRows = document.querySelectorAll("[data-timeline-row-id]");
    const lastRendered = renderedRows[renderedRows.length - 1];
    let scroller: HTMLElement | null = (lastRendered as HTMLElement | undefined) ?? null;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1) {
      scroller = scroller.parentElement;
    }
    buffer.push({
      t: Date.now(),
      dom: document.querySelector('[data-timeline-row-id="working-indicator-row"]') !== null,
      rendered: renderedRows.length,
      stop,
      dfb: scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : null,
    });
    sessionStorage.setItem(KEY, JSON.stringify(buffer));
  }, 100);
};

const armDomSampler = async (page: Page): Promise<void> => {
  await page.addInitScript(DOM_SAMPLER);
  await page.evaluate(DOM_SAMPLER).catch(() => undefined);
};

const readDomSamples = (page: Page): Promise<DomSample[]> =>
  page
    .evaluate(
      ({ key }) => {
        try {
          return JSON.parse(sessionStorage.getItem(key) ?? "[]") as unknown[];
        } catch {
          return [] as unknown[];
        }
      },
      { key: DOM_KEY },
    )
    .then((value) => value as DomSample[])
    .catch(() => [] as DomSample[]);

interface BlindWindow {
  readonly ms: number;
  readonly from: number;
  readonly to: number;
  readonly sample: DomSample | null;
}

/**
 * THE VERDICT. A sample is BLIND when the app offers "Stop generation" while the
 * DOM carries no working row. The longest uninterrupted run of blind samples is
 * the defect's duration; a healthy tree never sustains one (the row mounts within
 * a frame or two of the send, so short runs are startup transients).
 */
const longestBlindWindow = (samples: ReadonlyArray<DomSample>): BlindWindow => {
  let best: BlindWindow = { ms: 0, from: 0, to: 0, sample: null };
  let runStart: number | null = null;
  let runSample: DomSample | null = null;
  for (const sample of samples) {
    if (sample.stop && !sample.dom) {
      runStart ??= sample.t;
      runSample ??= sample;
      const ms = sample.t - runStart;
      if (ms > best.ms) best = { ms, from: runStart, to: sample.t, sample: runSample };
    } else {
      runStart = null;
      runSample = null;
    }
  }
  return best;
};

/** Samples, run-length encoded — 10 Hz over minutes is unreadable raw. */
const dumpSamples = (samples: ReadonlyArray<DomSample>, t0: number): string => {
  const lines: string[] = [];
  let run: DomSample | null = null;
  let runStart = 0;
  let count = 0;
  const flush = (sample: DomSample) => {
    lines.push(
      `+${String(runStart - t0).padStart(6)}ms .. +${String(sample.t - t0).padStart(6)}ms dom=${
        sample.dom ? 1 : 0
      } stop=${sample.stop ? 1 : 0} rendered=${String(sample.rendered)} dfb=${String(
        sample.dfb === null ? null : Math.round(sample.dfb),
      )} (${String(count)} samples)`,
    );
  };
  for (const sample of samples) {
    if (
      run !== null &&
      run.dom === sample.dom &&
      run.stop === sample.stop &&
      run.rendered === sample.rendered
    ) {
      count += 1;
      continue;
    }
    if (run !== null) flush(run);
    run = sample;
    runStart = sample.t;
    count = 1;
  }
  if (run !== null) flush(run);
  return lines.join("\n");
};

const writeArtifact = (name: string, body: string): string => {
  const dir = NodePath.join(import.meta.dirname, "../.artifacts");
  NodeFS.mkdirSync(dir, { recursive: true });
  const file = NodePath.join(dir, name);
  NodeFS.writeFileSync(file, body);
  return file;
};

test.describe.configure({ mode: "serial" });

test("REPRO: the working row must not vanish from the DOM while the app says it is working", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const state = readHarnessState();
  await armDomSampler(page);
  const t0 = Date.now();
  const marks: Array<{ readonly label: string; readonly at: number }> = [];
  const mark = (label: string) => marks.push({ label, at: Date.now() });

  // ── (0) HISTORY. The defect is a virtualisation failure, so the list must
  // genuinely virtualize: content far taller than the ~748 px viewport.
  await openThread(page);
  mark("thread-open");
  for (const round of [1, 2]) {
    writeFakeControl(state, {
      delayMs: 0,
      responseText:
        `история ${String(round)} — ` +
        "довольно длинный ответ модели, который занимает несколько строк в пузыре, ".repeat(6),
      stream: { chunks: 4, gapMs: 500 },
    });
    await sendPrompt(page, `history send ${String(round)}`);
    await page.waitForTimeout(6_000);
  }
  mark("history-done");

  // ── (1) THE AGENTIC TURN: many foldable tool rows + a running fleet, parked
  // while still streaming — so the Stop cuts a live turn, as the owner's does.
  writeFakeControl(state, {
    delayMs: 0,
    responseText: "фоновая работа",
    richTurn: { toolCalls: 9, agents: 3, holdChunks: 40, holdGapMs: 700 },
  });
  await sendPrompt(page, "run some agentic flow");
  mark("agentic-sent");
  await page.waitForTimeout(12_000);

  // ── (2) STOP while the fleet runs and text streams.
  const stop = page.getByRole("button", { name: /^(Stop generation|Остановить генерацию)$/ });
  await stop.click({ timeout: 60_000 }).catch(() => undefined);
  mark("stopped");
  await page.waitForTimeout(5_000);

  // ── (3) THE NEXT SEND — the new turn makes the stopped one fold, which is the
  // commit the unmount was measured in.
  const rounds: string[] = [];
  for (const round of [1, 2]) {
    const needle = `после стопа ${String(round)}`;
    writeFakeControl(state, {
      delayMs: 0,
      responseText: needle,
      stream: { chunks: 20, gapMs: 1_000 },
    });
    const sendAt = Date.now();
    mark(`send-${String(round)}`);
    await sendPrompt(page, "continue");
    await page.waitForTimeout(26_000);
    const roundSamples = (await readDomSamples(page)).filter((s) => s.t >= sendAt);
    const roundBlind = longestBlindWindow(roundSamples);
    rounds.push(
      `round ${String(round)}: blind=${String(roundBlind.ms)}ms samples=${String(
        roundSamples.length,
      )}`,
    );
    console.log(`REPRO ${rounds.at(-1) ?? ""}`);
  }

  const samples = await readDomSamples(page);
  const blind = longestBlindWindow(samples);
  const body = [
    `marks: ${marks.map((m) => `${m.label}=+${String(m.at - t0)}ms`).join(" ")}`,
    `rounds:\n${rounds.join("\n")}`,
    `verdict: longest blind window = ${String(blind.ms)}ms (+${String(
      blind.from - t0,
    )}ms .. +${String(blind.to - t0)}ms)`,
    `blind sample: ${JSON.stringify(blind.sample)}`,
    "",
    "DOM samples (run-length encoded):",
    dumpSamples(samples, t0),
  ].join("\n");
  const file = writeArtifact("timer-bug-probe.txt", body);
  console.log(`REPRO artifact: ${file}`);

  if (blind.ms >= 2_000) {
    throw new Error(
      `THE WORKING ROW VANISHED: for ${String(blind.ms)}ms the composer offered "Stop generation" ` +
        `while the DOM carried no [data-timeline-row-id="working-indicator-row"].\n` +
        `first blind sample: ${JSON.stringify(blind.sample)}\n` +
        `full trace: ${file}`,
    );
  }
  console.log(`REPRO: longest blind window = ${String(blind.ms)}ms (trace ${file})`);
});
