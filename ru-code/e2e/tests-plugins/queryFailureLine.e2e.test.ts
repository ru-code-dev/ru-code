// ru-code S80 F1 (review) — a failure line a query's re-read put up is taken down by the next good read.
//
// THE CLAIM. Since S79 the demo's notes list and the auto-coder's forms are `ctx.query` reads, so
// the host re-reads them on every reconnect. When the socket drops under that re-read, the round
// rejects `transport` (V2-35) and the surface shows its failure line. The next reconnect's read is
// good, and its answer is EQUAL to the value held, so the host tells no value listener (V2-59). The
// surface must still take its failure line down: the read succeeded and the data on screen is the
// server's. Before S79 neither surface re-read on a reconnect, so no reconnect ever put a line up.
//
// THE TRANSPORT CONTROL is the one `invokeReadiness.e2e.test.ts` (b) and `autoCoder.e2e.test.ts`
// (S71 F2) use: the frame is WRITTEN, then the socket that carried it is closed — what a dropped
// network does to a request whose answer has not come back. The `send` hook is an observer: it
// never swallows, delays or fails a write. A first close (a network blip while nothing is in flight)
// makes the app reconnect by itself; the hook is armed for the NEXT frame of one method, which is
// the query's reconnect re-read. The app then reconnects again and the re-read after it is answered.
import { PLUGIN_WIRE_INIT, pluginWire } from "./pluginWire.ts";
import {
  closeDemoPanel,
  demoErrorText,
  demoPanel,
  expect,
  openAppWithDemo,
  openDemoPanel,
  test,
  type Page,
} from "./fixtures.ts";

const DROP_UNDER_REREAD = `
globalThis.__s80 = { armed: null, closedUnder: [], last: null };
const WS = globalThis.WebSocket;
const observedSend = WS.prototype.send;
WS.prototype.send = function (data) {
  const text = typeof data === "string" ? data : "";
  const result = observedSend.call(this, data);
  if (/"tag":"plugin\\.invoke"/.test(text)) {
    globalThis.__s80.last = this;
    const method = /"method":"([^"]+)"/.exec(text);
    const id = /"id":"?(\\d+)/.exec(text);
    if (method !== null && method[1] === globalThis.__s80.armed) {
      globalThis.__s80.armed = null;
      globalThis.__s80.closedUnder.push({ method: method[1], id: id === null ? "" : id[1], at: Date.now() });
      this.close(4000, "e2e S80: the connection dropped under the re-read");
    }
  }
  return result;
};
globalThis.__s80Blip = (method) => {
  globalThis.__s80.armed = method;
  if (globalThis.__s80.last !== null) globalThis.__s80.last.close(4000, "e2e S80: a network blip");
};
`;

interface Dropped {
  readonly method: string;
  readonly id: string;
  readonly at: number;
}

const dropped = (page: Page): Promise<ReadonlyArray<Dropped>> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __s80?: { closedUnder: Dropped[] } }).__s80?.closedUnder ?? [],
  );

/** A network blip now; the socket is closed again under the next frame of `method`. */
const blipThenDropUnder = (page: Page, method: string): Promise<void> =>
  page.evaluate((armed) => {
    (globalThis as unknown as { __s80Blip: (method: string) => void }).__s80Blip(armed);
  }, method);

/** Frames of `pluginId`'s `method` sent AFTER the one the socket closed under, and answered. */
const answeredAfterDrop = async (page: Page, pluginId: string, method: string): Promise<number> => {
  const [closed] = await dropped(page);
  if (closed === undefined) return 0;
  const wire = await pluginWire(page);
  return wire.requests.filter(
    (request) =>
      request.pluginId === pluginId &&
      request.method === method &&
      request.at > closed.at &&
      wire.answers.some((answer) => answer.at >= request.at && answer.ids.includes(request.id)),
  ).length;
};

const AUTO_CODER_LABEL = /^(Auto Coder|Авто Кодер)$/;
const NO_CONNECTION = /^(No connection to the server\.|Нет соединения с сервером\.)$/;

test.describe("plugins — a query's failure line after a dropped re-read (S80 F1)", () => {
  test.setTimeout(240_000);

  test("demo: the notes re-read the socket dropped under, then a good one — no failure line", async ({
    page,
  }) => {
    await page.addInitScript(PLUGIN_WIRE_INIT);
    await page.addInitScript(DROP_UNDER_REREAD);
    await openAppWithDemo(page);
    await openDemoPanel(page);
    expect(await demoErrorText(page), "the panel loaded its notes").toBe("");

    await blipThenDropUnder(page, "notes.list");
    await expect.poll(async () => (await dropped(page)).length, { timeout: 60_000 }).toBe(1);
    await expect
      .poll(() => answeredAfterDrop(page, "demo", "notes.list"), {
        timeout: 60_000,
        message: "the app reconnected and the notes were read again, and answered",
      })
      .toBeGreaterThan(0);

    await expect
      .poll(() => demoErrorText(page), {
        timeout: 10_000,
        message: "the read succeeded: the panel shows no failure line",
      })
      .toBe("");
    await closeDemoPanel(page);
  });

  test("auto-coder: the project re-read the socket dropped under, then a good one — no failure line", async ({
    page,
  }) => {
    await page.addInitScript(PLUGIN_WIRE_INIT);
    await page.addInitScript(DROP_UNDER_REREAD);
    await openAppWithDemo(page);
    await openDemoPanel(page);
    await closeDemoPanel(page);
    const button = page.getByRole("button", { name: AUTO_CODER_LABEL }).first();
    await expect(button).toBeVisible({ timeout: 30_000 });
    await button.dispatchEvent("click");
    const view = page
      .locator('[data-plugin-root="auto-coder"]')
      .filter({ has: page.getByRole("heading", { name: AUTO_CODER_LABEL }) });
    await expect(view.locator('[data-testid="ac-project-form"]')).toBeVisible({ timeout: 30_000 });

    await blipThenDropUnder(page, "project.get");
    await expect.poll(async () => (await dropped(page)).length, { timeout: 60_000 }).toBe(1);
    await expect
      .poll(() => answeredAfterDrop(page, "auto-coder", "project.get"), {
        timeout: 60_000,
        message: "the app reconnected and the project was read again, and answered",
      })
      .toBeGreaterThan(0);

    await expect(view.locator('[data-testid="ac-project-form"]')).toBeVisible();
    await expect(
      view.getByText(NO_CONNECTION),
      "the read succeeded: the project tab shows no failure line",
    ).toHaveCount(0, { timeout: 10_000 });
    await button.dispatchEvent("click");
  });
});

// ru-code S83 F1 (review) — the SAME path, with a note half-typed in the demo composer.
//
// THE CLAIM. A read that recovers from a dropped re-read is a READ: it puts the server's list on
// screen and takes the failure line down, and it leaves what the user is typing alone. Before S81
// the good EQUAL read told no listener (S80 F1's red above), so the draft stayed; since V2-60
// `failed → ready(equal)` notifies, the listener calls the store's `settle`, and `settle` also
// empties the draft (`plugin-demo/src/web/store.ts` `settle`). Only the user's own add clears it.
const DRAFT = "a note the user is still typing";

test.describe("plugins — a typed draft across a dropped re-read (S83 F1)", () => {
  test.setTimeout(240_000);

  test("demo: the notes re-read the socket dropped under, then a good EQUAL one — the typed draft stays", async ({
    page,
  }) => {
    await page.addInitScript(PLUGIN_WIRE_INIT);
    await page.addInitScript(DROP_UNDER_REREAD);
    await openAppWithDemo(page);
    await openDemoPanel(page);
    expect(await demoErrorText(page), "the panel loaded its notes").toBe("");
    const input = demoPanel(page).locator('[data-testid="demo-input"]');
    await input.fill(DRAFT);
    await expect(input, "the user typed a draft").toHaveValue(DRAFT);

    await blipThenDropUnder(page, "notes.list");
    await expect.poll(async () => (await dropped(page)).length, { timeout: 60_000 }).toBe(1);
    await expect
      .poll(() => answeredAfterDrop(page, "demo", "notes.list"), {
        timeout: 60_000,
        message: "the app reconnected and the notes were read again, and answered",
      })
      .toBeGreaterThan(0);
    // The failure line the dropped round put up is gone: the recovering read has been applied.
    await expect
      .poll(() => demoErrorText(page), {
        timeout: 10_000,
        message: "the read succeeded: the panel shows no failure line",
      })
      .toBe("");

    await expect(
      input,
      "a read the connection recovered with leaves the user's typed draft in the input",
    ).toHaveValue(DRAFT, { timeout: 5_000 });
    await closeDemoPanel(page);
  });
});
