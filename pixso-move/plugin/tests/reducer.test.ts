import { describe, expect, it } from "vitest";

import { initialState, reduce } from "../src/ui/state/reducer.ts";

describe("reduce", () => {
  it("settings-loaded fills settings and stays on main when a key exists", () => {
    const next = reduce(initialState, {
      type: "settings-loaded",
      settings: { serverUrl: "http://x", designerId: "dz_1", themeName: "onyx", themeMode: "dark" },
    });
    expect(next.settings.designerId).toBe("dz_1");
    expect(next.settingsLoaded).toBe(true);
    expect(next.screen).toBe("main");
  });

  it("settings-loaded opens the settings screen when no key is configured", () => {
    const next = reduce(initialState, {
      type: "settings-loaded",
      settings: { serverUrl: "http://x", designerId: "", themeName: "aurora", themeMode: "light" },
    });
    expect(next.screen).toBe("settings");
  });

  it("selection-state enables a valid verdict and clears stale preview/error when invalid", () => {
    const withPreview = { ...initialState, preview: "AAAA", rootName: "Old", sendError: "boom" };
    const invalid = reduce(withPreview, {
      type: "selection-state",
      verdict: { ok: false, reason: "multiple" },
    });
    expect(invalid.preview).toBeNull();
    expect(invalid.rootName).toBe("");
    expect(invalid.sendError).toBeNull();
    const valid = reduce(initialState, {
      type: "selection-state",
      verdict: { ok: true, node: { id: "1", name: "Hero" } },
    });
    expect(valid.selectionVerdict.ok).toBe(true);
  });

  it("selection-state resets the preview when the node changes, keeps it for the same node", () => {
    const onA = { ...initialState, selectedNodeId: "A", preview: "IMG_A", rootName: "Frame A" };
    const sameA = reduce(onA, {
      type: "selection-state",
      verdict: { ok: true, node: { id: "A", name: "Frame A" } },
    });
    expect(sameA.preview).toBe("IMG_A");
    const toB = reduce(onA, {
      type: "selection-state",
      verdict: { ok: true, node: { id: "B", name: "Frame B" } },
    });
    expect(toB.preview).toBeNull();
    expect(toB.selectedNodeId).toBe("B");
  });

  it("preview-ready sets the image/name when it matches the selected node, ignores stale", () => {
    const selected = { ...initialState, selectedNodeId: "n1" };
    const next = reduce(selected, {
      type: "preview-ready",
      nodeId: "n1",
      preview: "PNG",
      rootName: "Hero",
    });
    expect(next.preview).toBe("PNG");
    expect(next.rootName).toBe("Hero");
    const stale = reduce(selected, {
      type: "preview-ready",
      nodeId: "other",
      preview: "PNG",
      rootName: "Hero",
    });
    expect(stale.preview).toBeNull();
  });

  it("collected carries rootName and preview", () => {
    const next = reduce(initialState, {
      type: "collected",
      nodesJson: "{}",
      rootName: "Hero",
      preview: "PNG",
      nodeCount: 2,
    });
    expect(next.rootName).toBe("Hero");
    expect(next.preview).toBe("PNG");
  });

  it("error sets sendError and stops sending", () => {
    const sending = { ...initialState, sending: true };
    const next = reduce(sending, { type: "error", message: "boom" });
    expect(next.sendError).toBe("boom");
    expect(next.sending).toBe(false);
  });

  it("send lifecycle: start, success clears error, failure records it", () => {
    const started = reduce({ ...initialState, sendError: "old" }, { type: "send-start" });
    expect(started.sending).toBe(true);
    expect(started.sendError).toBeNull();
    const success = reduce(started, { type: "send-result", result: { ok: true, nodeId: "n1" } });
    expect(success.sending).toBe(false);
    expect(success.sendError).toBeNull();
    const failure = reduce(started, {
      type: "send-result",
      result: { ok: false, message: "nope" },
    });
    expect(failure.sending).toBe(false);
    expect(failure.sendError).toBe("nope");
  });

  it("open/close settings switches the screen", () => {
    const opened = reduce(initialState, { type: "open-settings" });
    expect(opened.screen).toBe("settings");
    const closed = reduce(opened, { type: "close-settings" });
    expect(closed.screen).toBe("main");
  });

  it("edit-settings updates settings without changing the screen", () => {
    const edited = reduce(initialState, {
      type: "edit-settings",
      settings: {
        serverUrl: "http://y",
        designerId: "dz_9",
        themeName: "vs-code",
        themeMode: "dark",
      },
    });
    expect(edited.settings.serverUrl).toBe("http://y");
    expect(edited.screen).toBe("main");
  });
});
