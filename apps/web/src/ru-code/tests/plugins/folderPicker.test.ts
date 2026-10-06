// ru-code v2 (V2-33): the request store behind `ctx.pickFolder` — resolve, cancel, one at a time,
// and what happens with no host. The palette mode that ANSWERS it is browser-only and is proved in
// `ru-code/e2e/tests-plugins/pickFolder.e2e.test.ts`.
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  readFolderPickRequest,
  registerFolderPickerHost,
  requestFolderPick,
  resetFolderPickerForTests,
  respondToFolderPick,
  subscribeFolderPick,
} from "../../plugins/folderPicker";
import { resetPluginProblems } from "../../plugins/problems";
// V2-42: a host finding about a plugin is a status row and a console line, never a toast — so this
// is where every assertion below reads it from.
import { getPluginProblems as getPendingPluginProblems } from "../../plugins/status";

afterEach(() => {
  resetFolderPickerForTests();
  resetPluginProblems();
});

describe("folder picker request store (V2-33)", () => {
  it("resolves `null` at once when no host is mounted — never a promise nobody can answer", async () => {
    await expect(requestFolderPick("demo", undefined)).resolves.toBeNull();
    expect(readFolderPickRequest()).toBeNull();
  });

  it("shows the request to the host and resolves with the host's answer", async () => {
    const unregister = registerFolderPickerHost();
    let notified = 0;
    const unsubscribe = subscribeFolderPick(() => {
      notified += 1;
    });
    const picked = requestFolderPick("demo", "/home/me");
    expect(readFolderPickRequest()).toEqual({ pluginId: "demo", start: "/home/me" });
    expect(notified).toBe(1);
    respondToFolderPick("/home/me/projects");
    await expect(picked).resolves.toBe("/home/me/projects");
    expect(readFolderPickRequest()).toBeNull();
    expect(notified).toBe(2);
    unsubscribe();
    unregister();
  });

  it("a cancel is `null`, and answering with nothing active is a no-op", async () => {
    const unregister = registerFolderPickerHost();
    const picked = requestFolderPick("demo", undefined);
    respondToFolderPick(null);
    await expect(picked).resolves.toBeNull();
    respondToFolderPick("/never");
    expect(readFolderPickRequest()).toBeNull();
    unregister();
  });

  it("one at a time: a second request waits, then becomes the active one, in order", async () => {
    const unregister = registerFolderPickerHost();
    const first = requestFolderPick("demo", "/a");
    const second = requestFolderPick("other", "/b");
    expect(readFolderPickRequest()?.start).toBe("/a");
    respondToFolderPick("/a/x");
    await expect(first).resolves.toBe("/a/x");
    expect(readFolderPickRequest()).toEqual({ pluginId: "other", start: "/b" });
    respondToFolderPick(null);
    await expect(second).resolves.toBeNull();
    unregister();
  });

  it("the host going away cancels the active AND the queued requests", async () => {
    const unregister = registerFolderPickerHost();
    const first = requestFolderPick("demo", undefined);
    const second = requestFolderPick("demo", undefined);
    unregister();
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(readFolderPickRequest()).toBeNull();
    // …and with the host gone, a new request is answered at once again.
    await expect(requestFolderPick("demo", undefined)).resolves.toBeNull();
  });

  // S26 A2: the queue is CAPPED like every other plugin-facing surface (`host-rules`) — ONE pending
  // request per plugin. A button with no in-flight guard clicked five times opens one picker; the
  // other four are answered `null` at once and the plugin is told once; after the one answer the
  // palette is idle again (no re-open), so ⌘K and Esc behave.
  it("caps rapid repeats: one pending request per plugin, the excess resolves `null` and is reported once", async () => {
    const unregister = registerFolderPickerHost();
    const asks = Array.from({ length: 5 }, () => requestFolderPick("demo", undefined));
    expect(readFolderPickRequest()).toEqual({ pluginId: "demo", start: undefined });
    await expect(asks[1]).resolves.toBeNull();
    await expect(asks[2]).resolves.toBeNull();
    await expect(asks[3]).resolves.toBeNull();
    await expect(asks[4]).resolves.toBeNull();
    const reported = getPendingPluginProblems().filter((p) => p.code === "cap:pickFolder");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.pluginId).toBe("demo");
    // The one open request is still the plugin's to get an answer to…
    respondToFolderPick("/picked");
    await expect(asks[0]).resolves.toBe("/picked");
    // …and the palette is idle: nothing queued behind it re-opens the dialog.
    expect(readFolderPickRequest()).toBeNull();
    // Another plugin's request while `demo` is pending is NOT the excess — the queue is per plugin.
    const demoAgain = requestFolderPick("demo", undefined);
    const other = requestFolderPick("other", undefined);
    expect(readFolderPickRequest()?.pluginId).toBe("demo");
    respondToFolderPick(null);
    await expect(demoAgain).resolves.toBeNull();
    expect(readFolderPickRequest()?.pluginId).toBe("other");
    respondToFolderPick("/o");
    await expect(other).resolves.toBe("/o");
    unregister();
  });

  it("two hosts: the picker stays available until the LAST one leaves", async () => {
    const one = registerFolderPickerHost();
    const two = registerFolderPickerHost();
    const picked = requestFolderPick("demo", undefined);
    one();
    expect(readFolderPickRequest()).not.toBeNull();
    respondToFolderPick("/kept");
    await expect(picked).resolves.toBe("/kept");
    two();
  });
});
