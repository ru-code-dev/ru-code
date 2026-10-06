// ru-code v2: the `WebCtx` seam — the containment rule on `assetUrl`, the validation on `toast`,
// and the signals a plugin watches. Everything a plugin can reach is on this object, so everything
// it can get wrong with it is here.
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { invalidToastCall, pluginAssetUrl } from "@smart-tools/plugin-sdk/host-rules";

import { folderPickStart, makeWebCtx } from "../../plugins/ctx";
import {
  readFolderPickRequest,
  registerFolderPickerHost,
  resetFolderPickerForTests,
  respondToFolderPick,
} from "../../plugins/folderPicker";
import {
  pluginSeamVersion,
  resetPluginInvalidations,
  seamVersions,
} from "../../plugins/invalidations";
import { getPendingPluginProblems, resetPluginProblems } from "../../plugins/problems";
// V2-42: what the HOST has to say about a plugin is a status row and a console line, never a toast.
import { getPluginProblems } from "../../plugins/status";
import {
  activeProjectSignal,
  makeSignal,
  projectsSignal,
  providerSignal,
  resetPluginSignals,
  setPluginProjects,
  themeSignal,
  toPluginConnection,
} from "../../plugins/signals";

beforeEach(() => {
  resetPluginProblems();
  resetPluginSignals();
  resetPluginInvalidations();
});

describe("pluginAssetUrl", () => {
  it("puts the file under the plugin's own prefix", () => {
    expect(pluginAssetUrl("demo", "assets/logo.svg")).toBe("/plugins/demo/assets/logo.svg");
  });

  it.each(["", "/etc/passwd", "../other/x", "a/../../b", "a/./b"])(
    "refuses %o rather than quietly rewriting it",
    (rel) => {
      // A leading slash THROWS and is not stripped: `assetUrl("/etc/passwd")` quietly becoming
      // `/plugins/demo/etc/passwd` gives an author the opposite of the documented behaviour, which
      // is how a real traversal attempt goes unnoticed.
      expect(() => pluginAssetUrl("demo", rel)).toThrow(/not a contained relative path/);
    },
  );

  it("refuses a NUL byte", () => {
    expect(() => pluginAssetUrl("demo", "a\0b")).toThrow();
  });
});

describe("invalidToastCall", () => {
  it("accepts a well-formed call", () => {
    expect(invalidToastCall("success", "Saved", "3 notes")).toBeNull();
    expect(invalidToastCall("info", "Saved", undefined)).toBeNull();
  });

  const notAString: unknown = { toString: (): string => "x" };

  // SUPERSEDED PIN (S111 #7, #8): this table also named `message` for `""` and for 201 chars, and
  // `detail` for 1001 chars. Neither guarded anything: the toast draws its title and description
  // as React children in a stack that wraps and scrolls; what guards the MEASURED crash (v1: a
  // `{ toString }` object replaced the app with React's crash card) is the "is a string" clause.
  it.each<readonly [string, unknown, unknown, unknown]>([
    ["kind", "shout", "Saved", undefined],
    ["message", "info", notAString, undefined],
    ["message", "info", undefined, undefined],
    ["detail", "info", "Saved", 42],
    ["detail", "info", "Saved", notAString],
  ])("names %s as the unusable field", (field, kind, message, detail) => {
    expect(invalidToastCall(kind, message, detail)).toBe(field);
  });

  // SUPERSEDED PIN (S111 #7, #8): this case refused a bidi override in the message. The toast is
  // the plugin's own product text, drawn as given; a control character is not a crash.
  it("S111 #7, #8: takes any STRING message and detail — empty, 10,000 chars, multi-line, control or bidi", () => {
    for (const text of ["", "x".repeat(10_000), "line one\nline two", "Saved\u202E", "a\u0007b"]) {
      expect(invalidToastCall("info", text, undefined)).toBeNull();
      expect(invalidToastCall("error", "Saved", text)).toBeNull();
    }
  });
});

describe("makeWebCtx", () => {
  const ctx = () => makeWebCtx({ id: "demo", name: "Demo" });

  it("is bound to one plugin and carries no app internals", () => {
    const value = ctx();
    expect(value.pluginId).toBe("demo");
    expect(Object.keys(value).sort()).toEqual([
      "activeProject",
      "assetUrl",
      "closePanel",
      "composer",
      "connection",
      "invalidate",
      "invoke",
      "locale",
      "log",
      "pickFolder",
      "pluginId",
      "projects",
      "provider",
      // V2-59: a read the host keeps current.
      "query",
      // V2-58: the plugin's live values, one Signal per name.
      "state",
      "theme",
      "toast",
    ]);
  });

  // V2-33. The host's folder picker: one optional string in, one string or `null` out.
  describe("pickFolder", () => {
    it("resolves `null` with no picker host mounted", async () => {
      resetFolderPickerForTests();
      await expect(ctx().pickFolder({ start: "/tmp" })).resolves.toBeNull();
    });

    it("hands the request to the host, bound to THIS plugin, and returns the host's answer", async () => {
      resetFolderPickerForTests();
      const unregister = registerFolderPickerHost();
      const picked = ctx().pickFolder({ start: "/tmp" });
      expect(readFolderPickRequest()).toEqual({ pluginId: "demo", start: "/tmp" });
      respondToFolderPick("/tmp/chosen");
      await expect(picked).resolves.toBe("/tmp/chosen");
      unregister();
      resetFolderPickerForTests();
    });
  });

  // `start` is a HINT (V2-33): an unusable one means "home", never an error and never a report.
  describe("folderPickStart", () => {
    it.each([undefined, null, 42, {}, { start: 42 }, { start: "" }, { start: "   " }])(
      "%o → home",
      (options) => {
        expect(folderPickStart(options)).toBeUndefined();
      },
    );

    it("keeps a usable path, trimmed", () => {
      expect(folderPickStart({ start: "  ~/projects " })).toBe("~/projects");
    });

    it("drops a control character and a path over the wire's own cap", () => {
      expect(folderPickStart({ start: "/tmp/\u0007bell" })).toBeUndefined();
      expect(folderPickStart({ start: `/${"a".repeat(600)}` })).toBeUndefined();
    });

    // S111 R2-F4: the cap IS the app's browse wire (`FilesystemBrowseInput`, 512) — read from that
    // contract, so the hint and the browse it opens can never disagree.
    it("keeps a 512-char path and opens home for a 513-char one — the browse contract's own cap", () => {
      const at = `/${"a".repeat(511)}`;
      expect(folderPickStart({ start: at })).toBe(at);
      expect(folderPickStart({ start: `${at}b` })).toBeUndefined();
    });
  });

  // V2-25. The one member that is not a value and not a read: it says "ask me again".
  describe("invalidate", () => {
    it("bumps THIS plugin's version for the seam it names, and only that seam", () => {
      ctx().invalidate("composer");
      expect(pluginSeamVersion("demo", "composer")).toBe(1);
      expect(seamVersions("composer")).toEqual({ demo: 1 });
      expect(seamVersions("panels")).toEqual({});
    });

    it("is bound to the CALLER: a plugin can never make another plugin's surfaces recompute", () => {
      makeWebCtx({ id: "catalogs", name: "Catalogs" }).invalidate("panels");
      expect(pluginSeamVersion("catalogs", "panels")).toBe(1);
      expect(pluginSeamVersion("demo", "panels")).toBe(0);
    });

    it.each(["panel", "Composer", "", "rows"])(
      "DROPS %o and tells the author once, rather than counting a seam that does not exist",
      (seam) => {
        ctx().invalidate(seam as never);
        for (const name of ["composer", "panels", "pages", "background"] as const) {
          expect(seamVersions(name)).toEqual({});
        }
        const problems = getPluginProblems();
        expect(problems).toHaveLength(1);
        expect(problems[0]?.code).toBe("invalidate-invalid");
        expect(problems[0]?.detail).toContain("composer, panels, pages, background");
      },
    );
  });

  it("carries the V2-15 additions as SIGNALS and one bound function, nothing app-shaped", () => {
    const value = ctx();
    // Signals, not hooks and not stores: `get`/`subscribe` is the whole reactivity contract, and
    // the test below proves a plugin is handed nothing else — no `set`, no listener count.
    for (const signal of [value.activeProject, value.projects, value.provider]) {
      expect(signal.get).toBeTypeOf("function");
      expect(signal.subscribe).toBeTypeOf("function");
    }
    // The defaults are the values the app reports before anything has happened, and each is a
    // legitimate answer rather than a placeholder: no thread ⇒ no project and no provider.
    expect(value.activeProject.get()).toBe(null);
    expect(value.provider.get()).toBe(null);
    expect(value.projects.get()).toEqual([]);
    expect(value.closePanel).toBeTypeOf("function");
  });

  it("hands plugins READ-ONLY signal faces: no `set`, no listener count, but live values", () => {
    const value = ctx();
    for (const signal of [
      value.locale,
      value.theme,
      value.connection,
      value.activeProject,
      value.projects,
      value.provider,
    ]) {
      expect(Object.keys(signal).sort()).toEqual(["get", "subscribe"]);
      expect("set" in signal).toBe(false);
    }
    themeSignal.set("dark");
    expect(value.theme.get()).toBe("dark");
  });

  it("hands over the LIVE project signals, so a bridge push reaches an already-built ctx", () => {
    const value = ctx();
    activeProjectSignal.set("project-1");
    providerSignal.set("qwen");
    setPluginProjects([{ id: "project-1", name: "Alpha", cwd: "/tmp/alpha" }]);
    expect(value.activeProject.get()).toBe("project-1");
    expect(value.provider.get()).toBe("qwen");
    expect(value.projects.get()).toEqual([{ id: "project-1", name: "Alpha", cwd: "/tmp/alpha" }]);
  });

  it("does not notify project subscribers when the list is REBUILT but unchanged", () => {
    // The bridge recomputes on every app render that touches the project store; a fresh array of
    // identical rows would re-render every plugin component that watches it.
    setPluginProjects([{ id: "p", name: "P", cwd: "/p" }]);
    let notified = 0;
    const stop = projectsSignal.subscribe(() => (notified += 1));
    setPluginProjects([{ id: "p", name: "P", cwd: "/p" }]);
    expect(notified).toBe(0);
    setPluginProjects([{ id: "p", name: "P renamed", cwd: "/p" }]);
    expect(notified).toBe(1);
    stop();
  });

  it("routes a well-formed toast into the app's problem channel", () => {
    ctx().toast("success", "Note added", "3 total");
    const problems = getPendingPluginProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: "success", pluginId: "demo", title: "Note added" });
    expect(problems[0]?.code).toBeUndefined();
  });

  it("DROPS a malformed toast and tells the author once, instead of coercing it", () => {
    ctx().toast("error", { toString: () => "boom" } as never);
    // The AUTHOR is told (a status row + a console line); the USER is not (V2-42): a plugin whose
    // own toast call is malformed has nothing to say to the person using the app.
    const problems = getPluginProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe("toast-invalid");
    expect(problems[0]?.title).toContain("Demo");
    expect(getPendingPluginProblems()).toEqual([]);
  });

  it("hands over the live signals, not copies of their values", () => {
    const value = ctx();
    expect(value.theme.get()).toBe("light");
    themeSignal.set("dark");
    expect(value.theme.get()).toBe("dark");
  });
});

describe("signals", () => {
  it("notifies subscribers and unsubscribes cleanly", () => {
    const signal = makeSignal("a");
    let seen = 0;
    const stop = signal.subscribe(() => {
      seen += 1;
    });
    signal.set("b");
    expect(seen).toBe(1);
    expect(signal.listenerCount).toBe(1);
    stop();
    signal.set("c");
    expect(seen).toBe(1);
    expect(signal.listenerCount).toBe(0);
    expect(signal.get()).toBe("c");
  });

  it("does not notify when the value did not change", () => {
    const signal = makeSignal("a");
    let seen = 0;
    signal.subscribe(() => {
      seen += 1;
    });
    signal.set("a");
    expect(seen).toBe(0);
  });

  it("survives a listener that unsubscribes during the notification", () => {
    const signal = makeSignal(0);
    let stop = () => {};
    let other = 0;
    stop = signal.subscribe(() => {
      stop();
    });
    signal.subscribe(() => {
      other += 1;
    });
    signal.set(1);
    expect(other).toBe(1);
  });
});

describe("toPluginConnection", () => {
  it("maps the app's projection onto the SDK's closed vocabulary", () => {
    // v1 typed this `string`, and both shipped plugins had to discover `"ready"` empirically —
    // one of them shipped a permanently-false gate because the brief said `"connected"`.
    expect(toPluginConnection("ready")).toBe("ready");
    expect(toPluginConnection("disconnected")).toBe("lost");
    expect(toPluginConnection("synchronizing")).toBe("connecting");
    expect(toPluginConnection(null)).toBe("connecting");
  });
});
