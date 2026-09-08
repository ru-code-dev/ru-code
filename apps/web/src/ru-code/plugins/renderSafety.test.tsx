// ru-code (A13) — A12 findings R1-H1 / R1-H2 / R1-M5 / R1-L1, at the host seam.
//
// The fixtures are the auditor's, reduced to their essential four lines: a plugin panel whose
// `icon` throws (which used to replace the whole SPA with the crash card on EVERY page load, with
// no UI left to uninstall the plugin from) and one whose `render` throws (same crash card, on the
// first click).
//
// WHAT THIS FILE CAN AND CANNOT PROVE. `apps/web`'s unit project runs in the NODE environment —
// there is no jsdom or happy-dom in this repo — and React error boundaries do not participate in
// server rendering: verified against both `renderToStaticMarkup` and `renderToPipeableStream`, a
// component that throws re-throws out of the renderer in either. So what is pinned here is the
// MECHANISM, in the two halves that are testable without a DOM:
//
//  1. the boundary class itself — `getDerivedStateFromError` keeps the error, the fallback may be a
//     function of it, and `componentDidCatch` reports exactly once;
//  2. the seam — what `registerPanel` hands the registry is NOT the plugin's own function any more,
//     and calling the registered `render(...)` no longer THROWS: the plugin's call moved inside a
//     component the boundary owns, which is the whole of the H2 fix.
//
// The rendered result (a fallback icon, a fallback card, the app still interactive, the problem
// reported once) is pinned in a real browser by
// `ru-code/e2e/tests-plugins/renderFaults.e2e.test.ts`.
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { isValidElement, Suspense } from "react";

import { RenderErrorBoundary } from "~/components/RenderErrorBoundary";

import {
  invalidComposerItemFields,
  invalidPanelFields,
  invalidToastFields,
  makeWebPluginHost,
  MAX_COMPOSER_ITEMS_PER_PLUGIN,
  MAX_PANELS_PER_PLUGIN,
  MAX_REGISTRATION_CALLS_PER_PLUGIN,
  MAX_REGISTRATION_LABEL_LENGTH,
  MAX_TOAST_DESCRIPTION_LENGTH,
  MAX_TOAST_TITLE_LENGTH,
  pluginAssetUrl,
} from "./hostApi";
import { getPendingPluginProblems, resetPluginProblems } from "./problems";
import {
  pluginIdFromPanelId,
  pluginPanelCrashCandidate,
  PluginPanelSlotBoundary,
  recoverFromPluginPanelCrash,
  reportPluginSuspended,
  resetPluginRenderFaultReports,
  safePluginIcon,
  safePluginPanelRender,
} from "./renderSafety";
import { resetComposerPort, setComposerPort } from "./composerPort";
import {
  overlayPanelById,
  resetRegisteredOverlayPanels,
} from "../skills-agents/rightGlobalPanel/registry";
import {
  makeGlobalPanelId,
  useRightGlobalPanelStore,
} from "../skills-agents/rightGlobalPanel/store";

const ThrowingIcon = () => {
  throw new Error("A12 icon boom");
};
const throwingRender = () => {
  throw new Error("A12 panel render boom");
};

const status = { id: "boomer", name: "Boomer" };

/** Call one function element and answer the TYPE of what it rendered. */
const renderOnce = (node: unknown): unknown => {
  const element = node as { readonly type: unknown; readonly props: Record<string, unknown> };
  if (typeof element.type !== "function") return element.type;
  return (element.type as (props: Record<string, unknown>) => { readonly type: unknown })(
    element.props,
  ).type;
};

beforeEach(() => {
  resetRegisteredOverlayPanels();
  resetPluginProblems();
  resetPluginRenderFaultReports();
  resetComposerPort();
  useRightGlobalPanelStore.getState().close();
});

describe("RenderErrorBoundary — the shape the plugin seam needs", () => {
  it("keeps the caught error and renders a FUNCTION fallback with it", () => {
    const error = new Error("A12 icon boom");
    expect(RenderErrorBoundary.getDerivedStateFromError(error)).toEqual({ failed: true, error });

    const boundary = new RenderErrorBoundary({
      children: null,
      fallback: (caught: unknown) => `fallback: ${String(caught)}`,
    });
    boundary.state = { failed: true, error };
    expect(boundary.render()).toBe("fallback: Error: A12 icon boom");
  });

  it("still accepts a plain node fallback (the two pre-existing callers)", () => {
    const boundary = new RenderErrorBoundary({ children: "child", fallback: "plain" });
    expect(boundary.render()).toBe("child");
    boundary.state = { failed: true, error: new Error("x") };
    expect(boundary.render()).toBe("plain");
  });

  it("reports through onError exactly once, however often React calls it", () => {
    const seen: unknown[] = [];
    const boundary = new RenderErrorBoundary({
      children: null,
      fallback: null,
      onError: (error) => seen.push(error),
    });
    const error = new Error("boom");
    boundary.componentDidCatch(error);
    boundary.componentDidCatch(error);
    expect(seen).toEqual([error]);
  });
});

describe("safePluginIcon / safePluginPanelRender", () => {
  it("wraps the icon in a boundary instead of mounting it raw", () => {
    const Safe = safePluginIcon({ pluginId: "boomer", pluginName: "Boomer", icon: ThrowingIcon });
    expect(Safe).not.toBe(ThrowingIcon);
    // BEFORE: `<Icon />` was the plugin's own component and threw inside the sidebar's render.
    // AFTER: calling it yields a boundary element whose CHILD is the plugin's component.
    // `PluginIconComponent` is `ComponentType`, a union with `ComponentClass`; a plain call needs
    // the function arm, which is what the SDK's own `defineWebPlugin` examples all supply.
    const element = (Safe as (props: { size?: number }) => unknown)({ size: 16 });
    expect(isValidElement(element)).toBe(true);
    // One level down is the boundary. The indirection is deliberate — see `renderSafety.tsx`'s
    // header: a capitalised component defined inside the factory was compiled by the React
    // Compiler into a module-level closure over a variable that no longer existed.
    expect(renderOnce(element)).toBe(RenderErrorBoundary);
  });

  it("moves the plugin's render() INSIDE the boundary — the call no longer throws", () => {
    const wrapped = safePluginPanelRender({
      pluginId: "boomer",
      pluginName: "Boomer",
      render: throwingRender,
      toPluginMode: (mode) => (mode === "sheet" ? "sheet" : "sidebar"),
    });
    // BEFORE this fix the equivalent call — `panel.render(mode, onClose)` in
    // `RightGlobalPanelHost` — threw synchronously, OUTSIDE any boundary, which is why the whole
    // SPA became the crash card.
    expect(() => wrapped("sidebar", () => {})).not.toThrow();
    expect(renderOnce(wrapped("sidebar", () => {}))).toBe(RenderErrorBoundary);
  });
});

describe("makeWebPluginHost — what reaches the overlay registry", () => {
  it("registers a wrapped icon and a wrapped render, never the plugin's own functions", () => {
    const { host } = makeWebPluginHost(status);
    host.registerPanel({ label: "Boom", icon: ThrowingIcon, render: throwingRender });

    const panelId = makeGlobalPanelId("plugin:boomer");
    if (panelId === null) throw new Error("the host built an id the registry cannot hold");
    const registered = overlayPanelById(panelId);
    expect(registered).not.toBeNull();
    expect(registered?.icon).not.toBe(ThrowingIcon);
    const icon = registered?.icon as ((props: Record<string, never>) => unknown) | undefined;
    expect(() => icon?.({})).not.toThrow();
    expect(() => registered?.render("sidebar", () => {})).not.toThrow();
  });
});

describe("registration caps (R1-M5)", () => {
  it("registers at most MAX_PANELS_PER_PLUGIN panels and reports the overflow once", () => {
    const { host, panelIds } = makeWebPluginHost(status);
    for (let index = 0; index < 1000; index += 1) {
      host.registerPanel({
        id: `p${String(index)}`,
        label: `Panel ${String(index)}`,
        icon: () => null,
        render: () => null,
      });
    }
    expect(panelIds).toHaveLength(MAX_PANELS_PER_PLUGIN);
    const overflow = getPendingPluginProblems().filter((problem) =>
      problem.title.includes("too many panels"),
    );
    expect(overflow).toHaveLength(1);
  });

  it("registers at most MAX_COMPOSER_ITEMS_PER_PLUGIN composer items and reports once", () => {
    const seen: string[] = [];
    setComposerPort({
      registerItem: (_pluginId, item) => seen.push(item.name),
      // A22 (SDK 0.3.0): `registerProvider` is a REQUIRED member of `ComposerPort`. These fixtures
      // exercise the panel/icon boundaries, not the provider seam, so it records nothing.
      registerProvider: () => {},
      attach: () => {},
      detach: () => {},
      useActiveTarget: () => null,
    });
    const { host } = makeWebPluginHost(status);
    for (let index = 0; index < 200; index += 1) {
      host.composer.registerItem({
        trigger: "command",
        name: `c${String(index)}`,
        label: "l",
        description: "d",
        prompt: "p",
      });
    }
    expect(seen).toHaveLength(MAX_COMPOSER_ITEMS_PER_PLUGIN);
    const overflow = getPendingPluginProblems().filter((problem) =>
      problem.title.includes("too many composer items"),
    );
    expect(overflow).toHaveLength(1);
  });
});

describe("pluginAssetUrl (R1-L1)", () => {
  it("THROWS on a leading slash instead of silently stripping it", () => {
    expect(() => pluginAssetUrl("demo", "/etc/passwd")).toThrow(/contained relative path/);
    expect(() => pluginAssetUrl("demo", "//etc/passwd")).toThrow(/contained relative path/);
  });

  it("still contains the ordinary cases", () => {
    expect(pluginAssetUrl("demo", "assets/logo.svg")).toBe("/plugins/demo/assets/logo.svg");
    expect(() => pluginAssetUrl("demo", "../x")).toThrow();
    expect(() => pluginAssetUrl("demo", "a/../b")).toThrow();
    expect(() => pluginAssetUrl("demo", "")).toThrow();
  });
});

// ── A12 round 2 ─────────────────────────────────────────────────────────────────────────────────

/**
 * R2-H1: the panel SLOT boundary, driven the way React drives it.
 *
 * The auditor's fixture is four lines — a panel body whose `useEffect` cleanup throws — and the
 * fault is raised by the most ordinary interaction there is: clicking the footer icon a second
 * time to CLOSE the panel. Because the cleanup runs in the commit that removes the subtree, every
 * boundary inside the panel is being torn down with it and React walked past them to the router
 * root: the whole app replaced by the crash card, with no `[plugins]` line and no toast.
 *
 * There is no DOM in this project (see the header), so what is pinned here is the boundary's own
 * contract in the exact SEQUENCE React uses — mount, update with the panel gone, then catch — and
 * the browser half is pinned by `renderFaults.e2e.test.ts`'s unmount case.
 */
type MutableBoundary = {
  props: {
    readonly children: null;
    readonly pluginId: string | null;
    readonly onPluginFault: () => void;
  };
  state: { readonly failed: boolean; readonly error: unknown };
};

const mountSlotBoundary = (pluginId: string | null, onPluginFault: () => void) => {
  const boundary = new PluginPanelSlotBoundary({ children: null, onPluginFault, pluginId });
  // React owns `setState`; standing in for it keeps the assertion on what the boundary DOES.
  boundary.setState = (updater: unknown) => {
    (boundary as unknown as MutableBoundary).state = {
      ...boundary.state,
      ...(updater as { failed: boolean; error: unknown }),
    };
  };
  boundary.componentDidMount();
  return boundary;
};

describe("PluginPanelSlotBoundary (R2-H1)", () => {
  it("catches a cleanup throw raised AFTER the panel was closed and blames the right plugin", () => {
    let closes = 0;
    const boundary = mountSlotBoundary("panelunmount", () => {
      closes += 1;
    });

    // The user clicks the footer icon again: the store closes, the host re-renders with no panel,
    // and only THEN does the removed subtree's effect cleanup run.
    (boundary as unknown as MutableBoundary).props = {
      children: null,
      onPluginFault: boundary.props.onPluginFault,
      pluginId: null,
    };
    boundary.componentDidUpdate();

    const error = new Error("A12 panel unmount boom");
    expect(PluginPanelSlotBoundary.getDerivedStateFromError(error)).toEqual({
      failed: true,
      error,
    });
    boundary.componentDidCatch(error);

    // BEFORE: nothing caught this — `reportRenderFault` was never reached, so there was no
    // `[plugins] panelunmount: …` line, no toast, and the crash card owned the viewport.
    const problems = getPendingPluginProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.pluginId).toBe("panelunmount");
    expect(problems[0]?.detail).toContain("A12 panel unmount boom");
    expect(closes, "the panel is closed, not left half-torn-down").toBe(1);
    // The slot has to keep working for the next panel.
    expect(boundary.state.failed).toBe(false);
    expect(boundary.render()).toBeNull();
  });

  it("reports a plugin ONCE however many times its panel throws on the way out", () => {
    const boundary = mountSlotBoundary("panelunmount", () => {});
    boundary.componentDidCatch(new Error("first"));
    boundary.componentDidCatch(new Error("second"));
    expect(getPendingPluginProblems()).toHaveLength(1);
  });

  it("re-throws a BUILT-IN panel's failure instead of swallowing it", () => {
    const boundary = mountSlotBoundary(null, () => {
      throw new Error("a built-in panel must not be closed by the plugin net");
    });
    const error = new Error("built-in boom");
    (boundary as unknown as MutableBoundary).state =
      PluginPanelSlotBoundary.getDerivedStateFromError(error);
    expect(() => boundary.render()).toThrow("built-in boom");
    boundary.componentDidCatch(error);
    expect(getPendingPluginProblems()).toHaveLength(0);
  });

  it("reads the plugin out of a panel id, and only out of a plugin's", () => {
    expect(pluginIdFromPanelId("plugin:notes")).toBe("notes");
    expect(pluginIdFromPanelId("plugin:notes:board")).toBe("notes");
    expect(pluginIdFromPanelId("skills")).toBeNull();
    expect(pluginIdFromPanelId("plugin:")).toBeNull();
    expect(pluginIdFromPanelId(null)).toBeNull();
  });
});

describe("the router-root net (R2-H1, re-aimed by R3-H3)", () => {
  const openPanel = (id: string) => {
    const panelId = makeGlobalPanelId(id);
    if (panelId === null) throw new Error(`the test asked for an id the store cannot hold: ${id}`);
    useRightGlobalPanelStore.getState().toggle(panelId);
  };

  /** The only thing that sets the flag: a PLUGIN boundary catching. */
  const aPluginBoundaryCatches = (pluginId: string) => {
    mountSlotBoundary(pluginId, () => {}).componentDidCatch(new Error("A12 panel unmount boom"));
  };

  it("blames a plugin only when a plugin BOUNDARY just caught, not because a panel is open", () => {
    openPanel("plugin:boomer");
    // BEFORE (R3-H3): an OPEN PANEL was the whole of the evidence, so this read "boomer" — and it
    // read "boomer" just the same for an app-level crash that merely coincided with the panel.
    expect(pluginPanelCrashCandidate()).toBeNull();

    aPluginBoundaryCatches("boomer");
    expect(pluginPanelCrashCandidate()).toBe("boomer");

    recoverFromPluginPanelCrash("boomer", new Error("A12 panel unmount boom"));
    expect(useRightGlobalPanelStore.getState().open).toBeNull();
    // The boundary and the net share one surface name, so the user is told exactly once.
    expect(getPendingPluginProblems()).toHaveLength(1);

    // A SECOND crash from the same plugin is not recovered from: at that point the app may
    // genuinely be broken and the crash card is the honest answer.
    expect(pluginPanelCrashCandidate()).toBeNull();
  });

  it("attributes at BOOT, where no panel is open at all (R3-H3)", () => {
    // The auditor's `toastboot` shape: the fault is raised from `activate()`, so round 2's net
    // could not see it and the crash card owned the viewport on every reload, without naming the
    // plugin.
    expect(useRightGlobalPanelStore.getState().open).toBeNull();
    aPluginBoundaryCatches("toastboot");
    expect(pluginPanelCrashCandidate()).toBe("toastboot");
  });

  it("never touches a built-in panel or a closed slot", () => {
    expect(pluginPanelCrashCandidate()).toBeNull();
    openPanel("skills");
    expect(pluginPanelCrashCandidate()).toBeNull();
    // A built-in panel's own boundary never flags: `componentDidCatch` returns before the flag.
    mountSlotBoundary(null, () => {}).componentDidCatch(new Error("built-in boom"));
    expect(pluginPanelCrashCandidate()).toBeNull();
  });
});

/**
 * R3-H1 / R3-H2: plugin React that SUSPENDS was contained by nothing.
 *
 * An error boundary catches a THROW; a `React.lazy` icon whose loader never settles, or a `render`
 * that returns a pending promise, SUSPENDS — and with no `<Suspense>` above the plugin's surfaces
 * React unwound to the root and rendered nothing at all. The auditor's screenshot is a pure white
 * 1440×900 viewport with no console line, no toast and no page error.
 *
 * There is no DOM here (see the header), so what is pinned is the ELEMENT TREE the seam builds —
 * a Suspense with a fallback inside each boundary — plus the two pieces of behaviour that are
 * plain functions: the thenable refusal and the report the fallbacks arm.
 */
describe("suspension containment (R3-H1 / R3-H2)", () => {
  /** Call one function element and answer the element it rendered. */
  const renderElement = (
    node: unknown,
  ): { readonly type: unknown; readonly props: Record<string, unknown> } => {
    const element = node as { readonly type: unknown; readonly props: Record<string, unknown> };
    return (
      element.type as (props: Record<string, unknown>) => {
        readonly type: unknown;
        readonly props: Record<string, unknown>;
      }
    )(element.props);
  };

  it("puts a Suspense with a fallback INSIDE the icon boundary", () => {
    const Safe = safePluginIcon({ pluginId: "boomer", pluginName: "Boomer", icon: () => null });
    const boundary = renderElement((Safe as (props: { size?: number }) => unknown)({ size: 16 }));
    expect(boundary.type).toBe(RenderErrorBoundary);
    const suspense = boundary.props["children"] as {
      type: unknown;
      props: Record<string, unknown>;
    };
    // BEFORE: `children` was the plugin's own `<Icon/>` — a suspension had nowhere to land.
    expect(suspense.type).toBe(Suspense);
    expect(isValidElement(suspense.props["fallback"])).toBe(true);
  });

  it("puts a Suspense with a fallback INSIDE the panel boundary", () => {
    const wrapped = safePluginPanelRender({
      pluginId: "boomer",
      pluginName: "Boomer",
      render: () => null,
      toPluginMode: (mode) => (mode === "sheet" ? "sheet" : "sidebar"),
    });
    const boundary = renderElement(wrapped("sidebar", () => {}));
    expect(boundary.type).toBe(RenderErrorBoundary);
    const suspense = boundary.props["children"] as {
      type: unknown;
      props: Record<string, unknown>;
    };
    expect(suspense.type).toBe(Suspense);
    expect(isValidElement(suspense.props["fallback"])).toBe(true);
  });

  it("REFUSES a render() that returns a thenable, inside the boundary", () => {
    const bodyOf = (render: () => unknown) => {
      const wrapped = safePluginPanelRender({
        pluginId: "boomer",
        pluginName: "Boomer",
        render: render as () => null,
        toPluginMode: (mode) => (mode === "sheet" ? "sheet" : "sidebar"),
      });
      const boundary = renderElement(wrapped("sidebar", () => {}));
      const suspense = boundary.props["children"] as { props: Record<string, unknown> };
      return suspense.props["children"];
    };

    // BEFORE: React 19 `use()`s a thenable child, so this suspended the whole tree from the click
    // that opened the panel — and stayed blank after the panel was closed.
    expect(() => renderElement(bodyOf(() => new Promise(() => {})))).toThrow(/Promise|ReactNode/);
    // A thenable that is NOT a promise is the same hazard — React `use()`s anything with a `then`.
    // eslint-disable-next-line unicorn/no-thenable -- that IS the fixture.
    const fakeThenable = { then: () => {} };
    expect(() => renderElement(bodyOf(() => fakeThenable))).toThrow(/Promise|ReactNode/);
    // An ordinary node is untouched — the seam refuses a shape, not a value.
    expect(() => renderElement(bodyOf(() => null))).not.toThrow();
    expect(() => renderElement(bodyOf(() => "text"))).not.toThrow();
  });

  it("reports a surface that is STILL suspended when its budget runs out, once", () => {
    reportPluginSuspended({
      pluginId: "hang",
      pluginName: "Hang",
      surface: "icon",
      message: "the icon never finished loading",
    });
    reportPluginSuspended({
      pluginId: "hang",
      pluginName: "Hang",
      surface: "icon",
      message: "the icon never finished loading",
    });
    const problems = getPendingPluginProblems();
    // BEFORE: NOTHING was reported for a suspension — that is what made the blank page undebuggable.
    expect(problems).toHaveLength(1);
    expect(problems[0]?.pluginId).toBe("hang");
    expect(problems[0]?.detail).toContain("icon:");
  });
});

/**
 * R3-H3: `host.toast` is the third path a plugin has into React and round 2 validated only the
 * first two. A non-string title reached `<Toast.Title>` as a CHILD; raised from `activate()` it
 * replaced the app with the crash card on every boot, and a reload did not help.
 */
describe("toast argument validation (R3-H3)", () => {
  it("names exactly the toast fields that are unusable", () => {
    expect(invalidToastFields("Saved", undefined)).toEqual([]);
    expect(invalidToastFields("Saved", "3 notes")).toEqual([]);
    // The auditor's fixture, verbatim.
    expect(invalidToastFields({ toString: () => "t", evil: true }, undefined)).toEqual(["title"]);
    expect(invalidToastFields("", undefined)).toEqual(["title"]);
    expect(invalidToastFields("   ", undefined)).toEqual(["title"]);
    expect(invalidToastFields("x".repeat(MAX_TOAST_TITLE_LENGTH + 1), undefined)).toEqual([
      "title",
    ]);
    expect(invalidToastFields("x".repeat(MAX_TOAST_TITLE_LENGTH), undefined)).toEqual([]);
    expect(invalidToastFields("ok", 42)).toEqual(["description"]);
    expect(invalidToastFields("ok", "x".repeat(MAX_TOAST_DESCRIPTION_LENGTH + 1))).toEqual([
      "description",
    ]);
    expect(invalidToastFields("ok", "")).toEqual([]);
  });

  it("DROPS the call and reports it once, coercing nothing", () => {
    const { host } = makeWebPluginHost(status);
    const evil = { toString: () => "t", evil: true } as unknown as string;
    host.toast.error(evil);
    host.toast.error(evil);
    host.toast.success(evil, { bad: true } as unknown as string);

    const problems = getPendingPluginProblems();
    // BEFORE: three problems whose `title` was the OBJECT itself, handed to React as a child.
    expect(problems).toHaveLength(1);
    expect(problems[0]?.title).not.toBe(evil);
    expect(typeof problems[0]?.title).toBe("string");
    expect(problems[0]?.detail).toContain("title");

    // A well-formed toast still goes through, as many times as the plugin raises it.
    host.toast.success("Note added");
    host.toast.success("Note added");
    expect(getPendingPluginProblems().filter((p) => p.title === "Note added")).toHaveLength(2);
  });
});

/**
 * R3-H4: 300 INVALID registrations wedged the tab — round 2 reported every one of them, and the
 * report ran BEFORE the cap. A thousand WELL-FORMED registrations booted in 1865 ms; three hundred
 * malformed ones stopped the page answering `1+1`.
 */
describe("the registration flood (R3-H4)", () => {
  it("reports ONE problem per surface for 300 malformed registrations", () => {
    const seen: string[] = [];
    setComposerPort({
      registerItem: (_pluginId, item) => seen.push(item.name),
      // A22 (SDK 0.3.0): `registerProvider` is a REQUIRED member of `ComposerPort`. These fixtures
      // exercise the panel/icon boundaries, not the provider seam, so it records nothing.
      registerProvider: () => {},
      attach: () => {},
      detach: () => {},
      useActiveTarget: () => null,
    });
    const { host, panelIds } = makeWebPluginHost(status);
    for (let index = 0; index < 300; index += 1) {
      host.registerPanel({
        id: `b${String(index)}`,
        label: { o: index },
        icon: () => null,
        render: () => null,
      } as unknown as Parameters<typeof host.registerPanel>[0]);
      host.composer.registerItem({
        trigger: "command",
        name: `b${String(index)}`,
        label: 42,
        prompt: "x",
      } as unknown as Parameters<typeof host.composer.registerItem>[0]);
    }
    expect(panelIds).toHaveLength(0);
    expect(seen).toEqual([]);

    const problems = getPendingPluginProblems();
    // BEFORE: 600 — one per call, each with its own toast and console line.
    expect(problems.filter((p) => p.detail?.includes("panel fields"))).toHaveLength(1);
    expect(problems.filter((p) => p.detail?.includes("composer item fields"))).toHaveLength(1);
    // …plus the ceiling, once per surface, and nothing else.
    expect(problems.filter((p) => p.detail?.includes("registration calls"))).toHaveLength(2);
    expect(problems).toHaveLength(4);
  });

  it("stops PROCESSING registrations past the ceiling, valid or not", () => {
    const { host, panelIds } = makeWebPluginHost(status);
    let reads = 0;
    for (let index = 0; index < 1000; index += 1) {
      host.registerPanel({
        get id() {
          reads += 1;
          return `p${String(index)}`;
        },
        label: `Panel ${String(index)}`,
        icon: () => null,
        render: () => null,
      } as unknown as Parameters<typeof host.registerPanel>[0]);
    }
    // The caps still hold…
    expect(panelIds).toHaveLength(MAX_PANELS_PER_PLUGIN);
    // …and past the ceiling the registration is not even LOOKED at.
    expect(reads).toBeLessThanOrEqual(MAX_REGISTRATION_CALLS_PER_PLUGIN * 3);
    expect(
      getPendingPluginProblems().filter((p) => p.detail?.includes("registration calls")),
    ).toHaveLength(1);
  });
});

/**
 * R3-L3 / R3-L4: two things a plugin can put in a field that the round-2 validation let through.
 */
describe("registration field edges (R3-L3 / R3-L4)", () => {
  it("does not let a THROWING getter abort activate()", () => {
    const panel = {
      get label(): string {
        throw new Error("A12 label getter boom");
      },
      icon: () => null,
      render: () => null,
    };
    // BEFORE: this propagated out of `invalidPanelFields` and out of `registerPanel`, so the
    // plugin lost every registration after the bad one.
    expect(invalidPanelFields(panel)).toEqual(["registration"]);
    const { host, panelIds } = makeWebPluginHost(status);
    expect(() =>
      host.registerPanel(panel as unknown as Parameters<typeof host.registerPanel>[0]),
    ).not.toThrow();
    expect(panelIds).toHaveLength(0);
    // …and the plugin's NEXT registration still works, which is the point.
    host.registerPanel({ id: "ok", label: "Fine", icon: () => null, render: () => null });
    expect(panelIds).toHaveLength(1);
  });

  it("refuses an invisible or direction-flipping label", () => {
    const panel = { label: "Fine", icon: () => null, render: () => null };
    expect(invalidPanelFields({ ...panel, label: "\u200b" })).toEqual(["label"]);
    expect(invalidPanelFields({ ...panel, label: "\u202eevil" })).toEqual(["label"]);
    expect(invalidPanelFields({ ...panel, label: "Notes\u0007" })).toEqual(["label"]);
    // An ordinary non-ASCII label is not a control character.
    expect(invalidPanelFields({ ...panel, label: "Заметки — 1" })).toEqual([]);
  });
});

/**
 * R2-H2: `label` is the third piece of plugin data that reaches React, and it reaches it as a
 * CHILD (`SidebarChrome.tsx`'s `<TooltipPopup>{panel.label}</TooltipPopup>`) — outside every
 * boundary `renderSafety.tsx` installs. A `label` that was an object replaced the whole app the
 * moment the user HOVERED the footer icon («Minified React error #31 … object with keys
 * {toString, evil}») and took a healthy second plugin down with it.
 */
describe("registration field validation (R2-H2)", () => {
  const panel = {
    label: "Fine",
    icon: () => null,
    render: () => null,
  };

  it("names exactly the panel fields that are unusable", () => {
    expect(invalidPanelFields(panel)).toEqual([]);
    // The auditor's fixture: a label object with a `toString`.
    expect(invalidPanelFields({ ...panel, label: { toString: () => "obj", evil: true } })).toEqual([
      "label",
    ]);
    expect(invalidPanelFields({ ...panel, label: "" })).toEqual(["label"]);
    expect(invalidPanelFields({ ...panel, label: "   " })).toEqual(["label"]);
    expect(invalidPanelFields({ ...panel, label: 42 })).toEqual(["label"]);
    expect(
      invalidPanelFields({ ...panel, label: "x".repeat(MAX_REGISTRATION_LABEL_LENGTH + 1) }),
    ).toEqual(["label"]);
    expect(
      invalidPanelFields({ ...panel, label: "x".repeat(MAX_REGISTRATION_LABEL_LENGTH) }),
    ).toEqual([]);
    expect(invalidPanelFields({ ...panel, id: { evil: true } })).toEqual(["id"]);
    expect(invalidPanelFields({ ...panel, icon: "not a component" })).toEqual(["icon"]);
    expect(invalidPanelFields({ ...panel, icon: undefined })).toEqual(["icon"]);
    // `memo` / `forwardRef` components are OBJECTS — lucide ships them, so they must pass.
    expect(invalidPanelFields({ ...panel, icon: { $$typeof: Symbol.for("react.memo") } })).toEqual(
      [],
    );
    expect(invalidPanelFields({ ...panel, render: 42 })).toEqual(["render"]);
    expect(invalidPanelFields({ ...panel, navHidden: "yes" })).toEqual(["navHidden"]);
    expect(invalidPanelFields(null)).toEqual(["registration"]);
    expect(invalidPanelFields("panel")).toEqual(["registration"]);
  });

  it("names exactly the composer item fields that are unusable", () => {
    const item = {
      trigger: "command",
      name: "review",
      label: "Review",
      description: "",
      prompt: "p",
    };
    expect(invalidComposerItemFields(item)).toEqual([]);
    expect(invalidComposerItemFields({ ...item, trigger: "shout" })).toEqual(["trigger"]);
    expect(invalidComposerItemFields({ ...item, name: "  " })).toEqual(["name"]);
    expect(invalidComposerItemFields({ ...item, label: { evil: true } })).toEqual(["label"]);
    // `label` and `description` are optional at run time — the registry falls back to `name`.
    expect(invalidComposerItemFields({ ...item, label: undefined })).toEqual([]);
    expect(invalidComposerItemFields({ ...item, description: 7 })).toEqual(["description"]);
    expect(invalidComposerItemFields({ ...item, prompt: null })).toEqual(["prompt"]);
    expect(invalidComposerItemFields({ ...item, prompt: async () => "p" })).toEqual([]);
    expect(invalidComposerItemFields(undefined)).toEqual(["item"]);
  });

  it("DROPS a panel whose label is not a string, and reports it once", () => {
    const { host, panelIds } = makeWebPluginHost(status);
    host.registerPanel({
      label: { toString: () => "obj", evil: true },
      icon: () => null,
      render: () => null,
    } as unknown as Parameters<typeof host.registerPanel>[0]);

    // BEFORE: this registration reached `registerOverlayPanel` and the object was handed to React
    // as a tooltip child; the first hover replaced the app with the crash card.
    expect(panelIds).toHaveLength(0);
    const problems = getPendingPluginProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.detail).toContain("label");
  });

  it("DROPS a malformed composer item without consuming a slot in the cap", () => {
    const seen: string[] = [];
    setComposerPort({
      registerItem: (_pluginId, item) => seen.push(item.name),
      // A22 (SDK 0.3.0): `registerProvider` is a REQUIRED member of `ComposerPort`. These fixtures
      // exercise the panel/icon boundaries, not the provider seam, so it records nothing.
      registerProvider: () => {},
      attach: () => {},
      detach: () => {},
      useActiveTarget: () => null,
    });
    const { host } = makeWebPluginHost(status);
    host.composer.registerItem({
      trigger: "command",
      name: "ok",
      label: { evil: true },
      description: "",
      prompt: "p",
    } as unknown as Parameters<typeof host.composer.registerItem>[0]);

    expect(seen).toEqual([]);
    expect(getPendingPluginProblems()).toHaveLength(1);
    expect(getPendingPluginProblems()[0]?.detail).toContain("label");
  });
});

/**
 * R2-M3: the R1-M5 caps counted CALLS, but both registries de-duplicate by id — so the documented
 * way to change a panel's label (register it again) was punished as abuse: the plugin was told it
 * "registered too many panels" and its surface froze at whatever the 4th call said.
 */
describe("registration caps count DISTINCT ids (R2-M3)", () => {
  it("lets one panel id be re-registered as often as the plugin likes", () => {
    const { host, panelIds } = makeWebPluginHost(status);
    for (let index = 0; index < 10; index += 1) {
      host.registerPanel({
        id: "only",
        label: `Only ${String(index)}`,
        icon: () => null,
        render: () => null,
      });
    }
    expect(panelIds).toHaveLength(1);
    const panelId = makeGlobalPanelId("plugin:boomer:only");
    if (panelId === null) throw new Error("the host built an id the registry cannot hold");
    // The LAST call wins — that is what re-registering is for.
    expect(overlayPanelById(panelId)?.label).toBe("Only 9");
    // BEFORE: «Плагин «boomer» зарегистрировал слишком много панелей», and the label froze at 3.
    expect(getPendingPluginProblems()).toEqual([]);
  });

  it("lets one composer row be re-registered as often as the plugin likes", () => {
    const seen: string[] = [];
    setComposerPort({
      registerItem: (_pluginId, item) => seen.push(item.label),
      // A22 (SDK 0.3.0): `registerProvider` is a REQUIRED member of `ComposerPort`. These fixtures
      // exercise the panel/icon boundaries, not the provider seam, so it records nothing.
      registerProvider: () => {},
      attach: () => {},
      detach: () => {},
      useActiveTarget: () => null,
    });
    const { host } = makeWebPluginHost(status);
    for (let index = 0; index < 30; index += 1) {
      host.composer.registerItem({
        trigger: "command",
        name: "only",
        label: `Only ${String(index)}`,
        description: "d",
        prompt: "p",
      });
    }
    expect(seen).toHaveLength(30);
    expect(seen.at(-1)).toBe("Only 29");
    expect(getPendingPluginProblems()).toEqual([]);
  });

  it("still caps DISTINCT ids — the abuse the cap was written for", () => {
    const { host, panelIds } = makeWebPluginHost(status);
    for (let index = 0; index < 50; index += 1) {
      host.registerPanel({
        id: `p${String(index)}`,
        label: `Panel ${String(index)}`,
        icon: () => null,
        render: () => null,
      });
    }
    expect(panelIds).toHaveLength(MAX_PANELS_PER_PLUGIN);
    expect(
      getPendingPluginProblems().filter((problem) => problem.title.includes("too many panels")),
    ).toHaveLength(1);
  });
});

/**
 * ru-code (A16, SDK 0.2.0): `registerPanel({ preferredWidth })`.
 *
 * Two properties, in the two places they can go wrong. The VALIDATION is here because the value
 * crosses the plugin boundary untyped and a `NaN` that gets through renders `width: NaNpx` — a
 * declaration browsers discard, collapsing the docked column to its flex minimum with nothing in
 * the console. The PASS-THROUGH is here because the host must hand the registry the raw request:
 * the clamp (320–960) and the "persisted user width wins" rule belong to `RightGlobalPanelHost`,
 * which owns the width, and are pinned by `tests/skills-agents/rightGlobalPanel/`.
 */
describe("panel preferredWidth (A16)", () => {
  const base = { label: "Analytics", icon: () => null, render: () => null };

  it("accepts a finite number and nothing else", () => {
    expect(invalidPanelFields(base)).toEqual([]);
    expect(invalidPanelFields({ ...base, preferredWidth: 900 })).toEqual([]);
    expect(invalidPanelFields({ ...base, preferredWidth: 0 })).toEqual([]);
    expect(invalidPanelFields({ ...base, preferredWidth: -5 })).toEqual([]);
    expect(invalidPanelFields({ ...base, preferredWidth: Number.NaN })).toEqual(["preferredWidth"]);
    expect(invalidPanelFields({ ...base, preferredWidth: Number.POSITIVE_INFINITY })).toEqual([
      "preferredWidth",
    ]);
    expect(invalidPanelFields({ ...base, preferredWidth: "900" })).toEqual(["preferredWidth"]);
    expect(invalidPanelFields({ ...base, preferredWidth: null })).toEqual(["preferredWidth"]);
    // A `valueOf` object is the coercion trap `Number.isFinite` closes: `+obj` would be 900.
    expect(invalidPanelFields({ ...base, preferredWidth: { valueOf: () => 900 } })).toEqual([
      "preferredWidth",
    ]);
  });

  it("hands the registry the width the plugin asked for, unclamped", () => {
    const { host } = makeWebPluginHost(status);
    host.registerPanel({ id: "wide", ...base, preferredWidth: 900 });
    const panelId = makeGlobalPanelId("plugin:boomer:wide");
    if (panelId === null) throw new Error("the host built an id the registry cannot hold");
    expect(overlayPanelById(panelId)?.preferredWidth).toBe(900);
  });

  it("omits the field entirely when the plugin did not ask", () => {
    const { host } = makeWebPluginHost(status);
    host.registerPanel({ id: "plain", ...base });
    const panelId = makeGlobalPanelId("plugin:boomer:plain");
    if (panelId === null) throw new Error("the host built an id the registry cannot hold");
    const registered = overlayPanelById(panelId);
    expect(registered).not.toBeNull();
    // Not `undefined`-valued: absent. `exactOptionalPropertyTypes` is on, and the registry's
    // consumers distinguish "asked for nothing" from "asked for undefined".
    expect(registered !== null && "preferredWidth" in registered).toBe(false);
  });

  it("refuses the whole registration when the width is unusable", () => {
    const { host, panelIds } = makeWebPluginHost(status);
    host.registerPanel({
      id: "bad",
      ...base,
      preferredWidth: Number.NaN,
    } as unknown as Parameters<typeof host.registerPanel>[0]);
    expect(panelIds).toHaveLength(0);
    expect(
      getPendingPluginProblems().some((problem) => problem.detail?.includes("preferredWidth")),
    ).toBe(true);
  });
});
