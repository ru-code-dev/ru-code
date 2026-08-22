// ru-code: shared fixtures — harness state (web URL, temp dirs, fake control
// file) + the scroll instrumentation every scroll spec injects.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { test as base, type Page } from "@playwright/test";

import type { HarnessState } from "../scripts/bootApp.ts";

const STATE_FILE = NodePath.join(import.meta.dirname, "../.artifacts/harness-state.json");

export function readHarnessState(): HarnessState {
  return JSON.parse(NodeFS.readFileSync(STATE_FILE, "utf8")) as HarnessState;
}

/** Rewrite the fake ACP's per-spawn behaviour knobs (read at every prompt). */
export function writeFakeControl(
  state: HarnessState,
  control: { readonly delayMs?: number; readonly responseText?: string },
): void {
  NodeFS.writeFileSync(state.controlFile, JSON.stringify(control));
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

/** Fetch the SERVER's /healthz (baked version + pid) — the #39 real-wire-fact source. */
export async function fetchServerHealthz(
  state: HarnessState,
): Promise<{ ok: boolean; version: string; pid: number }> {
  const response = await fetch(`${state.serverUrl}/healthz`);
  return (await response.json()) as { ok: boolean; version: string; pid: number };
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
