// ru-code S69 (V2-58): the state seam on the REAL wire — `plugin.state`, its one transport since
// V2-75 removed the notify transport.
//
// WHAT IT MEASURES, and why a spec of its own: `pluginWire.ts` records `plugin.invoke` only, and the
// state seam's frames are another RPC — `plugin.state` (a snapshot, then one frame per change). This
// recorder watches exactly that, per page, with its bytes and times:
//
//   1. THE BOOT FLOOR, re-stated in these frames: one subscription for the whole page, ONE frame
//      (the snapshot), and nothing after it on a clean boot.
//
// RUN IT ON ITS OWN SERVER BOOT (its own `playwright test` invocation, as the S69 runbook does):
// the floor is a clean boot's. Inside a batch, an earlier spec's cleanup is a real change the page's
// boot reconcile walks in — measured in S69: `catalogs.e2e.test.ts`'s `afterAll` deletes its seeded
// tree, the next page's reconcile publishes the emptier catalogs, and the page pays that
// change (a value frame), which is correct and is not the boot's floor.
//   2. ONE MUTATION, across two tabs: tab A walks a new skill in with the panel's Refresh; tab B
//      must receive it with no reload. PINNED: the exact frames each tab took for it
//      (S73 Q4). RECORDED only: the LATENCY from A sending its `skill.rescan` to B holding the value —
//      both clocks are this browser's.
//
// IT IS AN OBSERVER, like `pluginWire.ts`: it reads `WebSocket.prototype.send` and the message
// events and changes nothing.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, openChat, state, test, type Page } from "./fixtures.ts";
import {
  startColdPluginsApp,
  stopPluginsApp,
  type PluginsHarnessState,
} from "../harness/pluginsBoot.ts";
import { saveEvidenceJson } from "../harness/pluginsEvidence.ts";

const STATE_TAGS = ["plugin.state"] as const;

interface StateRequest {
  readonly at: number;
  readonly id: string;
  readonly tag: (typeof STATE_TAGS)[number];
  readonly text: string;
}
interface StateAnswer {
  readonly at: number;
  readonly requestId: string;
  readonly kind: string;
  readonly bytes: number;
  readonly text: string;
}
interface StateWire {
  readonly requests: ReadonlyArray<StateRequest>;
  readonly answers: ReadonlyArray<StateAnswer>;
  readonly rescans: ReadonlyArray<{ readonly at: number; readonly text: string }>;
}

const STATE_WIRE_INIT = `
globalThis.__stateWire = { requests: [], answers: [], rescans: [] };
const tracked = new Map();
const WS = globalThis.WebSocket;
const nativeSend = WS.prototype.send;
const hooked = new WeakSet();
const hook = (socket) => {
  if (hooked.has(socket)) return;
  hooked.add(socket);
  socket.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : "";
    for (const match of text.matchAll(/"requestId":"?(\\d+)/g)) {
      const id = match[1];
      if (!tracked.has(id)) continue;
      const kind = /"_tag":"(\\w+)"/.exec(text);
      globalThis.__stateWire.answers.push({
        at: Date.now(), requestId: id, kind: kind === null ? "" : kind[1], bytes: text.length, text,
      });
      break;
    }
  }, { capture: true });
};
WS.prototype.send = function (data) {
  hook(this);
  const text = typeof data === "string" ? data : "";
  const tag = /"tag":"(plugin\\.state)"/.exec(text);
  if (tag !== null) {
    const id = /"id":"?(\\d+)/.exec(text);
    const requestId = id === null ? "" : id[1];
    tracked.set(requestId, tag[1]);
    globalThis.__stateWire.requests.push({ at: Date.now(), id: requestId, tag: tag[1], text });
  } else if (/"tag":"plugin\\.invoke"/.test(text) && /"method":"skill\\.rescan"/.test(text)) {
    globalThis.__stateWire.rescans.push({ at: Date.now(), text });
  }
  return nativeSend.call(this, data);
};
`;

const stateWire = (page: Page): Promise<StateWire> =>
  page.evaluate(
    () =>
      ((globalThis as unknown as { __stateWire?: StateWire }).__stateWire ?? {
        requests: [],
        answers: [],
        rescans: [],
      }) as StateWire,
  );

/** Wait until the state wire goes quiet: no new request or answer for `quietPolls` polls. */
const settle = async (page: Page, quietPolls = 4): Promise<StateWire> => {
  let last = -1;
  let quiet = 0;
  let wire = await stateWire(page);
  for (let tick = 0; tick < 120; tick += 1) {
    wire = await stateWire(page);
    const size = wire.requests.length + wire.answers.length;
    if (size > 0 && size === last) {
      quiet += 1;
      if (quiet >= quietPolls) return wire;
    } else {
      quiet = 0;
      last = size;
    }
    await page.waitForTimeout(500);
  }
  return wire;
};

const PROBE_SKILL = { name: "e2e-state-probe", label: "E2e State Probe" };

const SKILLS_LABEL = /^(Менеджер Навыков|Skill manager)$/;
const SKILLS_REFRESH = /^(Обновить навыки|Refresh skills)$/;
const CATALOG_TAB = /^(Каталог|Catalog)$/;

const probeSkillFile = (): string =>
  NodePath.join(state().cliConfigDir, "skills", PROBE_SKILL.name, "SKILL.md");

const openSkills = async (page: Page): Promise<void> => {
  const button = page.getByRole("button", { name: SKILLS_LABEL }).first();
  await expect(button, "the catalogs plugin's footer entry").toBeVisible({ timeout: 60_000 });
  await button.dispatchEvent("click");
  await expect(page.getByRole("tab", { name: CATALOG_TAB }).first()).toBeVisible({
    timeout: 30_000,
  });
};

test.describe("plugins — the state seam on the wire (V2-58)", () => {
  test.afterAll(() => {
    NodeFS.rmSync(NodePath.dirname(probeSkillFile()), { recursive: true, force: true });
  });

  test("the boot holds ONE state subscription, and its ONE frame is the snapshot", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.addInitScript(STATE_WIRE_INIT);
    await openChat(page);
    const wire = await settle(page);
    const answerBytes = wire.answers.reduce((sum, answer) => sum + answer.bytes, 0);
    saveEvidenceJson("69-state-boot", {
      spec: "stateSeam.e2e.test.ts",
      requests: wire.requests.map((request) => ({ tag: request.tag, at: request.at })),
      answers: wire.answers.map((answer) => ({ kind: answer.kind, bytes: answer.bytes })),
      answerBytes,
    });

    // ONE subscription for the whole page, however many plugins.
    expect(wire.requests, JSON.stringify(wire.requests.map((request) => request.tag))).toHaveLength(
      1,
    );
    // ONE frame: the SNAPSHOT of every current value, and nothing after it on a clean boot.
    const chunks = wire.answers.filter((answer) => answer.kind === "Chunk");
    expect(chunks, JSON.stringify(chunks.map((chunk) => chunk.bytes))).toHaveLength(1);
    expect(chunks[0]?.text ?? "", "the stream's first frame is the snapshot").toContain(
      '"snapshot"',
    );
  });

  test("a change in ONE tab reaches another: its frames and its latency", async ({ page }) => {
    test.setTimeout(240_000);
    NodeFS.rmSync(NodePath.dirname(probeSkillFile()), { recursive: true, force: true });
    await page.addInitScript(STATE_WIRE_INIT);
    await openChat(page);
    await openSkills(page);

    const other = await page.context().newPage();
    try {
      await other.addInitScript(STATE_WIRE_INIT);
      await openChat(other);
      await settle(other);
      await settle(page);
      const beforeA = await stateWire(page);
      const beforeB = await stateWire(other);
      expect(
        await other.evaluate(() => document.body.innerText.includes("e2e-state-probe")),
        "tab B does not know the probe skill yet",
      ).toBe(false);

      // THE CHANGE: a file on disk, walked in by tab A's own Refresh.
      NodeFS.mkdirSync(NodePath.dirname(probeSkillFile()), { recursive: true });
      NodeFS.writeFileSync(
        probeSkillFile(),
        `---\nname: ${PROBE_SKILL.name}\ndescription: The state seam's latency probe.\n---\n\n# ${PROBE_SKILL.name}\n`,
        "utf8",
      );
      const refresh = page.getByLabel(SKILLS_REFRESH).first();
      await expect(refresh, "the panel's refresh control").toBeVisible({ timeout: 20_000 });
      await refresh.dispatchEvent("click");

      // TAB B holds the value, as a frame.
      await expect
        .poll(
          async () =>
            (await stateWire(other)).answers.some((answer) =>
              answer.text.includes(PROBE_SKILL.name),
            ),
          { timeout: 30_000, intervals: [100] },
        )
        .toBe(true);
      const afterA = await settle(page);
      const afterB = await settle(other);

      const sentAt = afterA.rescans.findLast((rescan) => rescan.text.includes('"force":true'))?.at;
      const heldAt = afterB.answers.find((answer) => answer.text.includes(PROBE_SKILL.name))?.at;
      expect(sentAt, "tab A sent its rescan").toBeDefined();
      expect(heldAt, "tab B received the value").toBeDefined();
      const latencyMs = (heldAt ?? 0) - (sentAt ?? 0);

      const delta = (before: StateWire, after: StateWire) => ({
        requests: after.requests.slice(before.requests.length).map((request) => request.tag),
        answers: after.answers
          .slice(before.answers.length)
          .map((answer) => ({ kind: answer.kind, bytes: answer.bytes })),
      });
      const mutation = { tabA: delta(beforeA, afterA), tabB: delta(beforeB, afterB) };
      saveEvidenceJson("69-state-mutation", {
        spec: "stateSeam.e2e.test.ts",
        latencyMs,
        mutation,
      });
      // The latency is not a budget — a MEASUREMENT, recorded above. The FRAMES are pinned, per tab
      // (S73 Q4; measured identical in S69 and S70 — `S69/evidence-*/69-state-mutation.json`,
      // `S70/71-*.json`): ONE change, so ONE value frame and no request. Tab A, which made the
      // change, pays exactly what tab B pays: the echo of its own rescan is no extra frame.
      expect(latencyMs).toBeGreaterThanOrEqual(0);
      const expected = { requests: [], answers: ["Chunk"] };
      for (const [tab, frames] of Object.entries(mutation)) {
        expect(
          { requests: frames.requests, answers: frames.answers.map((answer) => answer.kind) },
          `${tab}: ${JSON.stringify(frames)}`,
        ).toEqual(expected);
      }
    } finally {
      await other.close();
    }
  });
});

// S71 gap 1 — THE COLD BOOT in the state seam's own frames (V2-58). `catalogsBoot.e2e.test.ts`
// pins the cold floor in `plugin.invoke` frames only, and the probe above runs on a server whose
// catalogs were already walked. On a never-used base dir the catalogs plugin has published nothing
// (it publishes after a walk, never at activate), so the page's first frame cannot carry them: the
// boot reconcile's one walk per kind is what publishes each catalog — ONCE.
const CATALOG_NAMES = ["skill.catalog", "agent.catalog", "command.catalog"] as const;

test.describe("plugins — the state seam on a COLD boot (V2-58)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  let cold: PluginsHarnessState | null = null;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    cold = await startColdPluginsApp({ logName: "app-cold-s71-state.log" });
  });

  test.afterAll(async () => {
    if (cold === null) return;
    await stopPluginsApp(cold);
    if (NodePath.basename(cold.tmpRoot).startsWith("ru-code-e2e-plugins-cold-")) {
      NodeFS.rmSync(cold.tmpRoot, { recursive: true, force: true });
    }
    cold = null;
  });

  test("a cold boot: ONE subscription, and each catalog's value reaches the page exactly once", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const app = cold;
    expect(app, "the cold app booted").not.toBeNull();
    if (app === null) return;
    await page.addInitScript(STATE_WIRE_INIT);
    await page.goto(app.webUrl, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("button", { name: /Добавить проект|Add project/ }).first(),
      "the fresh browser reaches the authenticated app shell (0 projects)",
    ).toBeVisible({ timeout: 60_000 });
    const wire = await settle(page);
    const chunks = wire.answers.filter((answer) => answer.kind === "Chunk");
    const snapshot = chunks[0]?.text ?? "";
    /** How many times a catalog's value reached the page: in the snapshot, then as `value` frames. */
    const deliveries = Object.fromEntries(
      CATALOG_NAMES.map((name) => {
        const inSnapshot = snapshot.includes(`"pluginId":"catalogs","name":"${name}"`) ? 1 : 0;
        const asValues = chunks
          .slice(1)
          .reduce(
            (sum, chunk) =>
              sum +
              chunk.text.split(`"_tag":"value","pluginId":"catalogs","name":"${name}"`).length -
              1,
            0,
          );
        return [name, inSnapshot + asValues];
      }),
    );
    saveEvidenceJson("71-state-cold-boot", {
      spec: "stateSeam.e2e.test.ts",
      requests: wire.requests.map((request) => ({ tag: request.tag, at: request.at })),
      chunks: chunks.map((chunk) => chunk.bytes),
      deliveries,
    });

    expect(wire.requests, JSON.stringify(wire.requests.map((request) => request.tag))).toHaveLength(
      1,
    );
    expect(snapshot, "the stream's first frame is the snapshot").toContain('"snapshot"');
    // Each catalog: exactly ONE delivery — the value its boot walk published.
    expect(deliveries).toEqual(Object.fromEntries(CATALOG_NAMES.map((name) => [name, 1])));
  });
});
