// ru-code: shared fixtures — harness state (web URL, temp dirs, fake control
// file) + the scroll instrumentation every scroll spec injects.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect as playwrightExpect, test as base, type Page } from "@playwright/test";

import type { ReservedCaseId } from "../harness/fakePixsoMcp.ts";
import type { HarnessState } from "../scripts/bootApp.ts";

const STATE_FILE = NodePath.join(import.meta.dirname, "../.artifacts/harness-state.json");

export function readHarnessState(): HarnessState {
  return JSON.parse(NodeFS.readFileSync(STATE_FILE, "utf8")) as HarnessState;
}

// ru-code (extended-view redesign, H2): REPLAY a real qwen session into the fake-bound
// thread's transcript. The fake appends the JSONL's records to ITS transcript file (the one
// the extended view tails), copies the agent tree under its own session id (sidecar
// `parentSessionId` patched so the on-demand flow attaches) and mirrors every background
// launch / completion notification into its task registry (`qwen/status/session/tasks`),
// exactly where the `backgroundAgents`/`subAgent` knobs already put theirs. The turn stays
// OPEN while records land, so the extended view is genuinely LIVE for the paced variants.
export interface FakeReplayControl {
  /** Absolute path of the session JSONL. */
  readonly file: string;
  /** Absolute path of its `subagents/<session>/` tree (optional). */
  readonly subagentsDir?: string;
  readonly pacing:
    | { readonly kind: "instant" }
    | { readonly kind: "records"; readonly intervalMs: number }
    | { readonly kind: "time-scaled"; readonly scale: number; readonly maxGapMs?: number };
  /** Write only the first N records (the rest never land) — a deterministic mid-flight state. */
  readonly limit?: number;
  /** Keep the turn open this long after the last written record, then settle it. */
  readonly holdMs?: number;
  /** Default true: launches → registry rows (running), notifications flip their status. */
  readonly mirrorRegistry?: boolean;
  /** Default true: shift every timestamp so the replay's first record is "now" (elapsed
   *  timers read seconds, not days) — main file, agent files and sidecars alike. */
  readonly rebaseTimestamps?: boolean;
}

// ru-code (extended-view redesign, H3): PARK an approval in the browser harness. The fake
// writes a RUNNING call (no result) into the JSONL — a `run_shell_command`/`write_file` for
// `via: "tool"`, an `agent` launch for `via: "agent"` (the request then belongs to the
// subagent's inner tool) — puts the same call on the ACP wire, and sends
// `session/request_permission` (fakeAcpCore.ts `requestPermission`), which blocks the
// prompt until the composer answers. Approving/declining settles the call and the turn.
export interface FakeApprovalControl {
  readonly kind: "command" | "file-change";
  readonly via: "tool" | "agent";
  readonly command?: string;
  readonly filePath?: string;
  readonly content?: string;
}

/** Rewrite the fake ACP's per-spawn behaviour knobs (read at every prompt). */
export function writeFakeControl(
  state: HarnessState,
  control: {
    readonly replay?: FakeReplayControl;
    readonly approval?: FakeApprovalControl;
    readonly delayMs?: number;
    readonly responseText?: string;
    // ru-code (mid-turn wave, P3d): hold the turn open, then drain once — the
    // window in which a browser spec can send a SECOND message while the first
    // turn is genuinely running, which is the only state the delivery marks
    // exist in.
    // ru-code (live-issues T1): a SLOW, MULTI-CHUNK response — the baseline the
    // working-line specs pin. `chunks` deltas `gapMs` apart, so the turn is
    // genuinely running for roughly chunks*gapMs and the DOM timer has real
    // seconds to count. REAL wall-clock on purpose: the working timer ticks off a
    // `setInterval` over `new Date()` inside the browser
    // (MessagesTimeline.tsx:1326-1340), which nothing on this side can virtualize.
    readonly stream?: { readonly chunks: number; readonly gapMs: number };
    // ru-code (live-issues T1): N BACKGROUND agents launched in this turn and left
    // genuinely running in the fake's task registry (served over
    // `qwen/status/session/tasks`), with the main turn PARKED when `hold` — the
    // exact state the owner's scenario needs before pressing Stop.
    readonly backgroundAgents?: { readonly count: number; readonly hold?: boolean };
    // ru-code (agentic-flow wave, timer-bug): the repro turn that can FOLD —
    // `toolCalls` foldable work entries + `agents` background launches, then
    // parked while still streaming `holdChunks` text deltas
    // (fake-acp-server.ts FlowControl.richTurn).
    readonly richTurn?: {
      readonly toolCalls: number;
      readonly agents: number;
      readonly holdChunks?: number;
      readonly holdGapMs?: number;
    };
    readonly midTurn?: { readonly holdMs: number };
    // ru-code(e2e, agents): one qwen `agent` tool call for this prompt. Omitting
    // `settle` leaves the run open and the turn parked — the Stop leg.
    readonly subAgent?: {
      readonly title: string;
      readonly role: string;
      readonly innerTool?: string;
      readonly settle?: {
        readonly status: "completed" | "failed" | "cancelled";
        readonly result?: string;
      };
    };
  },
): void {
  NodeFS.writeFileSync(state.controlFile, JSON.stringify(control));
}

/**
 * Open the booted app on a FRESH draft thread. Landing on the web root reopens
 * whichever thread was last active, so a suite whose cases each need their own
 * thread must explicitly start one — otherwise case N asserts against case N-1's
 * rows. A real pointer click is intercepted by the hover-revealed header menu,
 * hence `dispatchEvent` (same reason messageFlow.e2e.test.ts uses it).
 */
export async function openThread(page: Page): Promise<void> {
  await page.goto(readHarnessState().webUrl, { waitUntil: "domcontentloaded" });
  await page.locator("div[contenteditable=true]").first().waitFor({ timeout: 30_000 });
  const newThread = page.getByRole("button", { name: /New thread|Новый диалог/ }).first();
  await newThread.dispatchEvent("click");
  await playwrightExpect(page).toHaveURL(/\/draft\//, { timeout: 30_000 });
  await page.locator("div[contenteditable=true]").first().waitFor({ timeout: 30_000 });
}

/**
 * Type into the composer and send. Verifies the text landed BEFORE Enter and
 * that the composer emptied AFTER it — the composer is a contenteditable whose
 * first keystrokes can race the editor's own mount, so a bare `type` + `Enter`
 * is flaky by construction (the same reason messageFlow.e2e.test.ts's richer
 * variant retries; this one carries no scroll-instrumentation hooks).
 */
export async function sendPrompt(page: Page, text: string): Promise<void> {
  const input = page.locator("div[contenteditable=true]").first();
  await input.click();
  await page.keyboard.type(text);
  await playwrightExpect(input).toContainText(text.slice(-12), { timeout: 15_000 });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.keyboard.press("Enter");
    const emptied = await input
      .textContent()
      .then((value) => !(value ?? "").includes(text.slice(-12)))
      .catch(() => false);
    if (emptied) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`composer never emptied after sending: ${text}`);
}

// ── ru-code: auto-update mock-update-source control (per-spec behaviour switch) ──

export type MockUpdateMode = "release" | "notfound" | "unauthorized" | "invalid" | "gonetarball";

/**
 * Switch the mock WEB update source's behaviour for the next request. The mock
 * re-reads its control file on every request, so a spec resets it (and, for the
 * counter cases, reads a fresh request baseline) before each check.
 */
export function setMockUpdateMode(state: HarnessState, mode: MockUpdateMode): void {
  // sha256 / sizeBytes / minNode were baked into the control file at boot; keep them
  // and change only the `mode`.
  const current = readMockControl(state);
  NodeFS.writeFileSync(state.mockControlFile, JSON.stringify({ ...current, mode }));
}

interface MockControl {
  readonly mode: MockUpdateMode;
  readonly version: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly minNode: string;
}

function readMockControl(state: HarnessState): MockControl {
  return JSON.parse(NodeFS.readFileSync(state.mockControlFile, "utf8")) as MockControl;
}

/** The mock server's monotonic request counter (only web requests ever reach it). */
export function readMockRequestCount(state: HarnessState): number {
  try {
    const raw = JSON.parse(NodeFS.readFileSync(state.mockRequestsFile, "utf8")) as {
      count?: number;
    };
    return typeof raw.count === "number" ? raw.count : 0;
  } catch {
    return 0;
  }
}

// ── ru-code: fake Pixso MCP control (per-spec behaviour switch) ─────────────────

/** normal = the synthesized payloads; dsl-error = a forced tool error; down = no listener;
 *  image-timeout = every tool works EXCEPT `get_image`, whose handler never answers. */
export type PixsoFakeMode = "normal" | "dsl-error" | "down" | "image-timeout";

/** F5 (branch-sync v5): thrown by the pixso control-file writers when `state.pixsoControlFile`
 *  is `""` — the harness never spawned the fake Pixso MCP (RU_CODE_E2E_PIXSO was unset, e.g.
 *  a spec run against playwright.config.ts instead of playwright.pixso.config.ts). A named
 *  class so the failure reads as "the wrong suite" rather than an ENOENT on an empty path. */
export class PixsoHarnessOffError extends Error {
  constructor(fnName: string) {
    super(
      `${fnName}: the fake Pixso MCP is off (RU_CODE_E2E_PIXSO unset) — ` +
        "run this spec via test:pixso / playwright.pixso.config.ts, not the core suite.",
    );
    this.name = "PixsoHarnessOffError";
  }
}

/**
 * Switch the fake Pixso MCP's behaviour. It re-reads the control file on EVERY request
 * (the mockUpdateServer idiom), so this takes effect on the very next scan without
 * restarting anything.
 *
 * Written tmp-then-rename because the reader is a DIFFERENT process running concurrently:
 * `writeFileSync` truncates first, so a request landing inside that window reads an empty
 * file and falls back to "normal" — the switch would silently not happen. A rename is
 * atomic, so every read sees either the old mode or the new one.
 */
export function setPixsoFakeMode(state: HarnessState, mode: PixsoFakeMode): void {
  if (state.pixsoControlFile === "") throw new PixsoHarnessOffError("setPixsoFakeMode");
  const temporary = `${state.pixsoControlFile}.tmp`;
  NodeFS.writeFileSync(temporary, JSON.stringify({ mode }));
  NodeFS.renameSync(temporary, state.pixsoControlFile);
}

/** S10 (quality wave, decisions 447/448, DS-1): LOCAL's entry point into the SAME shared
 *  reserved case vocabulary REMOTE reaches by item-id — the SAME control file, extended
 *  with a `case` field alongside `mode` (never a second selector; DS-1: local selection-
 *  addressing stays untouched). Always writes `mode:"normal"` — the reserved override
 *  lives entirely in `case`, so this never collides with `setPixsoFakeMode`'s own modes. */
export function setPixsoFakeCase(state: HarnessState, caseId: ReservedCaseId): void {
  if (state.pixsoControlFile === "") throw new PixsoHarnessOffError("setPixsoFakeCase");
  const temporary = `${state.pixsoControlFile}.tmp`;
  NodeFS.writeFileSync(temporary, JSON.stringify({ mode: "normal", case: caseId }));
  NodeFS.renameSync(temporary, state.pixsoControlFile);
}

/** Fetch the SERVER's /healthz (baked version + pid) — the #39 real-wire-fact source. */
export async function fetchServerHealthz(
  state: HarnessState,
): Promise<{ ok: boolean; version: string; pid: number }> {
  const response = await fetch(`${state.serverUrl}/healthz`);
  return (await response.json()) as { ok: boolean; version: string; pid: number };
}

/**
 * CACHE-WARM PREDICATE before an F5 in a just-promoted thread (messageFlow case 5's
 * proven gate, shared): the thread route's not-found guard trusts the RESTORED IndexedDB
 * shell cache, so a reload fired before the cache learned the promoted thread bounces to
 * the root wizard — a fresh-thread race, not the scenario a reload spec means. With the
 * extended-view redesign the core suite carries 12 more threads (real 150-record sessions),
 * the cache snapshot got heavier, and `midTurnDelivery`'s unguarded reload started landing on
 * the wizard (logs/impl-a/25c: snapshot = «Что будем создавать…»). State-based, never a sleep.
 */
export async function waitForShellCacheToLearnThread(page: Page): Promise<void> {
  const threadId = new URL(page.url()).pathname.split("/").at(-1)!;
  await playwrightExpect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const openRequest = indexedDB.open("ruCode:connection-runtime");
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            openRequest.addEventListener("success", () => resolve(openRequest.result), {
              once: true,
            });
            openRequest.addEventListener("error", () => reject(openRequest.error), { once: true });
          });
          try {
            const values = await new Promise<unknown[]>((resolve, reject) => {
              const getAll = database
                .transaction("shell", "readonly")
                .objectStore("shell")
                .getAll();
              getAll.addEventListener("success", () => resolve(getAll.result), { once: true });
              getAll.addEventListener("error", () => reject(getAll.error), { once: true });
            });
            return JSON.stringify(values).includes(id);
          } finally {
            database.close();
          }
        }, threadId),
      { timeout: 15_000, message: "the cached shell snapshot must learn the thread before F5" },
    )
    .toBe(true);
}

export interface ScrollSample {
  readonly t: number;
  readonly top: number;
}

export interface ScrollWriterLogEntry {
  readonly t: number;
  readonly kind: string;
  readonly value: number;
  readonly stack: string;
}

declare global {
  interface Window {
    __scrollTrace?: ScrollSample[];
    __scrollWriters?: ScrollWriterLogEntry[];
    __startScrollRecorder?: (hostSelector: string) => boolean;
  }
}

/** Injected before app code: writer tracer + on-demand rAF scrollTop recorder. */
export async function installScrollInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__scrollWriters = [];
    const log = (kind: string, value: number) => {
      window.__scrollWriters?.push({
        t: performance.now(),
        kind,
        value,
        stack: new Error("writer").stack ?? "",
      });
    };
    const originalScrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function scrollToTraced(
      this: Element,
      ...args: [ScrollToOptions] | [number, number]
    ) {
      const top = typeof args[0] === "object" ? (args[0]?.top ?? -1) : (args[1] ?? -1);
      log("scrollTo", typeof top === "number" ? top : -1);
      return (originalScrollTo as (...inner: unknown[]) => void).apply(this, args as unknown[]);
    };
    const originalScrollBy = Element.prototype.scrollBy;
    Element.prototype.scrollBy = function scrollByTraced(
      this: Element,
      ...args: [ScrollToOptions] | [number, number]
    ) {
      const top = typeof args[0] === "object" ? (args[0]?.top ?? -1) : (args[1] ?? -1);
      log("scrollBy", typeof top === "number" ? top : -1);
      return (originalScrollBy as (...inner: unknown[]) => void).apply(this, args as unknown[]);
    };
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    if (descriptor?.set && descriptor.get) {
      Object.defineProperty(Element.prototype, "scrollTop", {
        get: descriptor.get,
        set(this: Element, value: number) {
          log("scrollTop=", value);
          descriptor.set?.call(this, value);
        },
      });
    }
    // The timeline stamps `data-testid="extended-chat-scroller"` on the REAL
    // LegendList scroll node (ExtendedMessagesTimeline effect); the class
    // substring stays as a fallback for older bundles.
    window.__startScrollRecorder = (hostSelector: string) => {
      const host = document.querySelector(hostSelector);
      const node = (host?.querySelector('[data-testid="extended-chat-scroller"]') ??
        host?.querySelector('[class*="overscroll-y-contain"]') ??
        host) as HTMLElement | null;
      if (!node) return false;
      window.__scrollTrace = [];
      const sample = () => {
        window.__scrollTrace?.push({ t: performance.now(), top: node.scrollTop });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return true;
    };
  });
}

/** Trace verdicts shared by the scroll cases. */
export interface TraceVerdict {
  readonly totalDelta: number;
  readonly reversalPx: number;
  readonly movingFrames: number;
  /** Largest single-frame jump — a snap concentrates the motion in one step. */
  readonly maxStepPx: number;
}

/** Analyze a send's trace: total displacement, worst counter-direction reversal,
 *  how many frames actually moved (1 = instant snap, many = animation), and the
 *  biggest one-frame step (snap detector: one step carrying most of the motion). */
export function analyzeTrace(trace: ReadonlyArray<ScrollSample>): TraceVerdict {
  let reversalPx = 0;
  let movingFrames = 0;
  let maxStepPx = 0;
  const first = trace[0]?.top ?? 0;
  const last = trace.at(-1)?.top ?? 0;
  const direction = Math.sign(last - first) || 1;
  let extreme = first;
  for (let index = 1; index < trace.length; index += 1) {
    const previous = trace[index - 1]!.top;
    const current = trace[index]!.top;
    if (current !== previous) movingFrames += 1;
    maxStepPx = Math.max(maxStepPx, Math.abs(current - previous));
    // Track how far the trace moved AGAINST the overall direction from the
    // furthest point reached so far — the visible "jerk" magnitude.
    if (direction > 0) {
      extreme = Math.max(extreme, current);
      reversalPx = Math.max(reversalPx, extreme - current);
    } else {
      extreme = Math.min(extreme, current);
      reversalPx = Math.max(reversalPx, current - extreme);
    }
  }
  return { totalDelta: last - first, reversalPx, movingFrames, maxStepPx };
}

export const test = base;
export { expect } from "@playwright/test";
export type { Page } from "@playwright/test";
