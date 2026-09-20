// ru-code S37 — the COLD OPEN, on the defect the owner hit with his own data.
//
// THE OWNER'S REPORT (2026-09-19, after the squash). A never-used base dir, 0 projects, the
// analytics page opened FIRST. The server log says the scan SUCCEEDED — 1815 sessions,
// 1 582 177 bytes. The browser shows «Нет соединения с сервером» over an empty board, and the
// failure reads `Error: Expected JSON value at ["value"]`. Pressing ⟳ fills the board.
//
// Reproduced here, byte for byte and with nothing injected (`WORKFLOW/logs/S37/0-e2e-cold-red-owner.log`,
// evidence `37-analytics-cold-open.json`): ONE `analytics.refresh` frame out, a 130-byte answer
// carrying `{"_tag":"Die","defect":"Expected JSON value\n  at [\"value\"]"}`, an empty board and
// that sentence. Neither the browser console nor the server log holds that string — the RPC
// server squashes its own encode failure INTO the Die it sends, so it lives on the wire.
//
// WHY, PROVEN (S37 §0, `WORKFLOW/logs/S37/0-mechanism.log`). `plugin.invoke`'s success is
// `Schema.Unknown`, which effect lowers to `Schema.Json` for the wire; the RPC SERVER encodes the
// exit against it before the frame is written, and `isJson` walks OWN KEYS. The analytics parser
// gave every subagent bucket an own `lastError` key holding `undefined` — `AnalyticsAgentUsage`
// spells it `Schema.optional(Schema.String)`, so the type was satisfied and the package's own
// `encodeSnapshot` passed it through. `encodeExit` then refused the whole answer and the protocol
// sent a bare `Die` defect, which the host could only read as `transport`. ⟳ worked because the
// SECOND scan is served from the plugin's file cache, and `session_json` is written with
// `JSON.stringify`, which drops the key: the cached scan and the scan that produced it disagreed.
//
// WHY EVERY SPEC WAS GREEN. `agentUsage` is filled only by an `api_response` carrying
// `subagent_name`, and no harness corpus had one. This corpus does — it is the one field that
// separates a transcript with a subagent from one without, and the owner's three real transcripts
// in `ru-code/e2e/fixtures/sessions/` all carry it (verified in S37 §0.D, and the package's
// `tests/snapshotWireSafety.test.ts` folds that shape directly).
//
// WHAT THIS SPEC DOES NOT DO ANY MORE. It injects nothing. The old version hooked
// `WebSocket.prototype.send` to throw `InvalidStateError` — a fault a browser raises only for a
// socket that is not OPEN, which the app's transport never writes to (rule 36). The whole fault
// rig and the host's "one re-dispatch" that answered it are gone. The hook that remains is an
// OBSERVER: it counts frames and measures the answer's bytes, and never changes a byte.
//
// `startColdPluginsApp` gives the rest of the owner's setup: a fresh `mkdtemp` base dir (so the
// plugin's file cache is EMPTY and the first scan must parse every transcript), no project
// bootstrap at all, and its own port — so the browser context is empty too, which is the owner's
// "pair, then go straight there".
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  startColdPluginsApp,
  stopPluginsApp,
  type PluginsHarnessState,
} from "../harness/pluginsBoot.ts";
import { saveEvidenceJson } from "../harness/pluginsEvidence.ts";

import { expect, test, type Page } from "./fixtures.ts";

const PAGE = '[data-testid="analytics-page"]';
const ANALYTICS_LABEL = /^(Аналитика|Analytics)$/;
const SESSIONS_LABEL = /^(Сессий|Sessions)$/i;
/** The app shell's own affordance on a 0-PROJECT profile — «Пока нет проектов» + this button. */
const APP_SHELL_LABEL = /Добавить проект|Add project/;
/** Every failure sentence the dashboard can paint — none may appear on a healthy first open.
 *  «Нет соединения с сервером» is the one the owner saw; «Не удалось передать статистику» is the
 *  one S37 added for a plugin whose answer the host refuses. */
const ANY_FAILURE =
  /Не удалось обновить статистику|Could not refresh the analytics|Не удалось прочитать сохранённую статистику|Could not read the saved analytics|Служба статистики недоступна|The analytics service is unavailable|Нет прав на чтение статистики|No permission to read the analytics|Нет соединения с сервером|No connection to the server|Не удалось передать статистику|The analytics could not be delivered/;

/** Transcripts in the corpus. Every one of them carries a subagent, which is the whole point. */
const CORPUS = Number(process.env["RU_CODE_S37_CORPUS"] ?? 400);
/** Tool-call lines per transcript — the bulk a cold scan has to fold. */
const LINES = Number(process.env["RU_CODE_S37_LINES"] ?? 2);

// ── the corpus: the S10 fixture shape, plus the one field that fills `agentUsage` ─────────────

const isoAt = (daysAgo: number, hour: number): string => {
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  at.setUTCHours(hour, 0, 0, 0);
  return at.toISOString();
};

const uiLine = (input: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly ts: string;
  readonly event: Readonly<Record<string, unknown>>;
}): string =>
  JSON.stringify({
    type: "system",
    subtype: "ui_telemetry",
    cwd: input.cwd,
    gitBranch: "main",
    sessionId: input.sessionId,
    timestamp: input.ts,
    systemPayload: { uiEvent: { "event.timestamp": input.ts, ...input.event } },
  });

const sessionIdFor = (index: number): string =>
  `5c000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

/** The agent TYPE names qwen writes into `subagent_name` — `AgentCore.name`, the user's own. */
const AGENT_TYPES = ["Explore", "general-purpose", "fork"] as const;

function writeTranscript(cliConfigDir: string, index: number): void {
  const sessionId = sessionIdFor(index);
  const cwd = `/s37/cold-open/p${String(index % 8)}`;
  const promptId = `${sessionId}########0`;
  const apiResponse = (extra: Readonly<Record<string, unknown>>): string =>
    uiLine({
      cwd,
      sessionId,
      ts: isoAt(index % 20, 9),
      event: {
        "event.name": "qwen-code.api_response",
        model: "qwen/qwen3.6-35b-a3b",
        input_token_count: 800 + index,
        output_token_count: 120,
        cached_content_token_count: 0,
        thoughts_token_count: 0,
        duration_ms: 2_000,
        ttft_ms: 400,
        prompt_id: promptId,
        ...extra,
      },
    });
  const lines: Array<string> = [
    JSON.stringify({
      type: "user",
      cwd,
      sessionId,
      timestamp: isoAt(index % 20, 9),
      message: { role: "user", content: [{ type: "text", text: "cold-open fixture" }] },
    }),
    apiResponse({}),
    // THE ONE FIELD THAT MATTERS. qwen stamps `subagent_name` on every api_response a subagent
    // makes (`AgentCore.name`), and that is what fills `AnalyticsSession.agentUsage`. A bucket for
    // an agent that never errored is where the non-JSON `lastError: undefined` came from.
    apiResponse({
      subagent_name: AGENT_TYPES[index % AGENT_TYPES.length],
      input_token_count: 300,
      output_token_count: 40,
    }),
  ];
  for (let line = 0; line < LINES; line += 1) {
    lines.push(
      uiLine({
        cwd,
        sessionId,
        ts: isoAt(index % 20, 10),
        event: {
          "event.name": "qwen-code.tool_call",
          function_name: "read_file",
          success: true,
          decision: "auto_accept",
          duration_ms: 90,
          tool_type: "native",
          prompt_id: promptId,
        },
      }),
    );
  }
  const chats = NodePath.join(cliConfigDir, "projects", `-s37-co-p${String(index % 8)}`, "chats");
  NodeFS.mkdirSync(chats, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(chats, `${sessionId.replaceAll("-", "")}.jsonl`),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

const seedCorpus = (cliConfigDir: string): void => {
  for (let index = 0; index < CORPUS; index += 1) writeTranscript(cliConfigDir, index);
};

// ── watching the wire: frames out, BYTES in, and whether the answer was a defect ──────────────
//
// Rule 36 asks a boot path for frame counts AND byte counts, and the byte count is the assertion
// the owner's own log would have made: his server said "1 582 177 bytes" while the browser had
// nothing. Here the answer is read off the socket, so "the scan succeeded" and "the board has the
// data" cannot disagree without this spec noticing.

const WS_INIT = `
globalThis.__cold = { requests: [], answers: [], sockets: [] };
const WS = globalThis.WebSocket;
const nativeSend = WS.prototype.send;
const hook = (socket) => {
  if (socket.__coldHooked) return;
  socket.__coldHooked = true;
  const seq = globalThis.__cold.sockets.length;
  socket.__coldSeq = seq;
  globalThis.__cold.sockets.push({ at: Date.now(), event: "created", seq });
  socket.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : "";
    if (text === "") return;
    const ids = [...text.matchAll(/"requestId":"?(\\d+)/g)].map((match) => match[1]);
    if (ids.length === 0) return;
    globalThis.__cold.answers.push({
      at: Date.now(),
      ids,
      bytes: text.length,
      // The shape the S37 defect arrived in: an Exit whose cause is a Die, i.e. the RPC protocol
      // could not encode the answer. A typed PluginRpcError is a different (honest) shape.
      defect: /"_tag":"Die"|"_tag":"Defect"/.test(text),
      pluginError: /"PluginRpcError"/.test(text),
      // The owner's sentence, if this is his failure: the RPC server squashes its encode error
      // into the Die's payload, so \`Expected JSON value at ["value"]\` travels ON THE WIRE.
      defectText: (/"defect":"((?:[^"\\\\]|\\\\.)*)"/.exec(text) ?? ["", ""])[1].slice(0, 300),
    });
  }, { capture: true });
  for (const name of ["open", "close", "error"]) {
    socket.addEventListener(name, () =>
      globalThis.__cold.sockets.push({ at: Date.now(), event: name, seq }), { capture: true });
  }
};
WS.prototype.send = function (data) {
  hook(this);
  const text = typeof data === "string" ? data : "";
  const method = /"method":"(analytics\\.[a-zA-Z]+)"/.exec(text);
  if (method !== null) {
    const id = /"id":"?(\\d+)/.exec(text);
    globalThis.__cold.requests.push({
      at: Date.now(),
      id: id === null ? "" : id[1],
      method: method[1],
      bytes: text.length,
      socket: this.__coldSeq,
    });
  }
  return nativeSend.call(this, data);
};
`;

interface Wire {
  readonly requests: ReadonlyArray<{
    readonly at: number;
    readonly id: string;
    readonly method: string;
    readonly bytes: number;
    readonly socket: number;
  }>;
  readonly answers: ReadonlyArray<{
    readonly at: number;
    readonly ids: ReadonlyArray<string>;
    readonly bytes: number;
    readonly defect: boolean;
    readonly pluginError: boolean;
    readonly defectText: string;
  }>;
  readonly sockets: ReadonlyArray<{
    readonly at: number;
    readonly event: string;
    readonly seq: number;
  }>;
}

const wire = (page: Page): Promise<Wire> =>
  page.evaluate(
    () =>
      ((globalThis as unknown as { __cold?: Wire }).__cold ?? {
        requests: [],
        answers: [],
        sockets: [],
      }) as Wire,
  );

// ── reading the board ────────────────────────────────────────────────────────────────────────

interface Board {
  readonly mounted: boolean;
  readonly sessions: number;
  readonly failure: string;
  readonly state: string;
}

const board = (page: Page): Promise<Board> =>
  page.evaluate(
    ([selector, failure]: [string, string]) => {
      const root = document.querySelector(selector);
      if (root === null) return { mounted: false, sessions: -1, failure: "", state: "" };
      const text = root.textContent ?? "";
      const strip = root.querySelector('[class*="grid-cols-7"]');
      const tile =
        strip === null
          ? ""
          : (strip.children[3]?.querySelector('span[class*="font-mono"]')?.textContent ?? "");
      const match = new RegExp(failure).exec(text);
      const region = [
        ...root.querySelectorAll("p[class*='text-xs'], p[class*='text-destructive-foreground']"),
      ]
        .map((node) => (node.textContent ?? "").trim())
        .filter((value) => value !== "");
      return {
        mounted: true,
        sessions: Number.parseInt(tile.replace(/[^\d]/g, ""), 10),
        failure: match === null ? "" : match[0],
        state: region.join(" | "),
      };
    },
    [PAGE, ANY_FAILURE.source] as [string, string],
  );

// ── the spec ─────────────────────────────────────────────────────────────────────────────────

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("plugins — analytics, cold open on a fresh install", () => {
  test.setTimeout(300_000);

  let cold: PluginsHarnessState | null = null;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    cold = await startColdPluginsApp({ seedCorpus, logName: "app-cold-analytics.log" });
  });

  test.afterAll(async () => {
    if (cold === null) return;
    await stopPluginsApp(cold);
    if (NodePath.basename(cold.tmpRoot).startsWith("ru-code-e2e-plugins-cold-")) {
      NodeFS.rmSync(cold.tmpRoot, { recursive: true, force: true });
    }
    cold = null;
  });

  test("the first open of a fresh install puts the scanned corpus on screen, with no ⟳", async ({
    page,
  }) => {
    const app = cold;
    expect(app, "the cold app booted").not.toBeNull();
    if (app === null) return;

    const consoleLines: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.addInitScript(WS_INIT);

    // ── pair (auto-auth over loopback) and go STRAIGHT to the page ─────────────────────────
    await page.goto(app.webUrl, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("button", { name: APP_SHELL_LABEL }).first(),
      "the fresh browser reaches the authenticated app shell (0 projects)",
    ).toBeVisible({ timeout: 60_000 });

    const analytics = page.getByRole("button", { name: ANALYTICS_LABEL }).first();
    await expect(analytics, "the analytics plugin contributed its nav entry").toBeVisible({
      timeout: 60_000,
    });
    const clicked = await analytics
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) await analytics.dispatchEvent("click");
    await expect(page.locator(PAGE)).toBeVisible({ timeout: 30_000 });

    // ── watch the first open settle, WITHOUT ever pressing ⟳ ───────────────────────────────
    const timeline: Array<Board & { readonly at: number }> = [];
    const openedAt = Date.now();
    let last = "";
    let settled: Board | null = null;
    for (let tick = 0; tick < 120; tick += 1) {
      const current = await board(page);
      const key = `${String(current.sessions)}|${current.failure}|${current.state}`;
      if (key !== last) {
        last = key;
        timeline.push({ ...current, at: Date.now() - openedAt });
      }
      if (current.sessions >= CORPUS) {
        settled = current;
        break;
      }
      await page.waitForTimeout(250);
    }
    const finalBoard = settled ?? (await board(page));
    const frames = await wire(page);
    const refreshes = frames.requests.filter((request) => request.method === "analytics.refresh");
    const snapshots = frames.requests.filter(
      (request) => request.method === "analytics.getSnapshot",
    );
    /** The frame that carried the refresh's answer — the byte count rule 36 asks for. */
    const answerOf = (id: string) =>
      frames.answers
        .filter((answer) => answer.ids.includes(id))
        .toSorted((first, second) => second.bytes - first.bytes)[0];
    const refreshAnswer = refreshes[0] === undefined ? undefined : answerOf(refreshes[0].id);

    saveEvidenceJson("37-analytics-cold-open", {
      corpus: CORPUS,
      lines: LINES,
      baseDir: app.baseDir,
      finalBoard,
      timeline,
      requests: frames.requests,
      answers: frames.answers,
      sockets: frames.sockets,
      refreshAnswerBytes: refreshAnswer?.bytes ?? 0,
      analyticsConsole: consoleLines.filter((line) => line.includes("[analytics]")),
      // Where the owner's `Expected JSON value at ["value"]` actually lives: NOT the browser
      // console and NOT the server log — `RpcServer.handleEncode` squashes it into the Die it
      // sends, so it is in the answer frame itself (S37 §0.B).
      jsonValueOnTheWire: frames.answers
        .map((answer) => answer.defectText)
        .filter((text) => text.includes("Expected JSON value")),
      consoleErrors: consoleLines.filter((line) => line.startsWith("error:")).slice(0, 20),
      pageErrors,
    });

    const evidence =
      `requests=${JSON.stringify(frames.requests)} ` +
      `answers=${JSON.stringify(frames.answers)} ` +
      `timeline=${JSON.stringify(timeline)}`;

    // 1. The scan's answer ARRIVED — not as a defect, which is the S37 defect's exact signature.
    //    Before the fix this is where the spec goes red: the answer frame carries a `Die` whose
    //    payload is the owner's own `Expected JSON value at ["value"]`.
    expect(
      frames.answers.map((answer) => answer.defectText).filter((text) => text !== ""),
      `no plugin answer arrived as a squashed encode failure — ${evidence}`,
    ).toEqual([]);
    expect(
      frames.answers.filter((answer) => answer.defect),
      `no plugin answer arrived as a defect — ${evidence}`,
    ).toEqual([]);
    expect(
      frames.answers.filter((answer) => answer.pluginError),
      `…and none arrived as a typed plugin error either — ${evidence}`,
    ).toEqual([]);

    // 2. FRAME COUNT on the boot path (rule 36): the page reads the cache once and scans once.
    //    Nothing re-dispatches, nothing retries, and no reconnect doubles the scan.
    expect(snapshots, `exactly one analytics.getSnapshot — ${evidence}`).toHaveLength(1);
    expect(refreshes, `exactly one analytics.refresh — ${evidence}`).toHaveLength(1);

    // 3. BYTE COUNT (rule 36): the answer really carried the corpus. The owner's log said
    //    1 582 177 bytes for 1815 sessions; this corpus is smaller, and the floor below is
    //    deliberately far under the measured size so it pins "the data crossed", not a constant.
    expect(refreshAnswer, `the refresh's answer frame was seen — ${evidence}`).toBeDefined();
    expect(
      refreshAnswer?.bytes ?? 0,
      `the answer carried the corpus, not an empty envelope — ${String(refreshAnswer?.bytes)} bytes for ${String(CORPUS)} sessions`,
    ).toBeGreaterThan(CORPUS * 200);

    // 4. The board fills itself. No ⟳ was pressed anywhere in this test.
    expect(
      finalBoard.sessions,
      `the cold open puts the scanned corpus on screen by itself — ${evidence}`,
    ).toBeGreaterThanOrEqual(CORPUS);
    // 5. …and it does not end on any failure sentence.
    expect(finalBoard.failure, `the cold open does not settle on a failure — ${evidence}`).toBe("");
    await expect(
      page.locator(PAGE).getByText(SESSIONS_LABEL).first(),
      "the KPI strip is on the board",
    ).toBeVisible({ timeout: 30_000 });

    expect(pageErrors, "no page errors on the cold open").toEqual([]);
  });
});
