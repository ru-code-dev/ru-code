// ru-code (A24-fix, A24 finding H1): a composer provider's driver is a MOUNTED COMPONENT, and its
// hooks are live.
//
// THE DEFECT THIS FILE EXISTS FOR. `PluginBackgroundBody` used to CALL its `render` prop —
// `<>{render()}</>` — so a provider's `useRows` and the host hooks inside it attached to
// `PluginBackgroundBody`'s own fiber. React Compiler (`reactCompilerPreset()`, `vite.config.ts`)
// compiles that body to
//
//     let t1; if ($[0] !== render) { t1 = render(); $[0] = render; $[1] = t1; } else { t1 = $[1]; }
//
// and `render` is bound once per registration, so the call — and every hook inside it — ran EXACTLY
// ONCE, at mount, for the life of the page. A `registerBackgroundView` sibling under the same
// surface stayed live only because the documented idiom returns an ELEMENT (`() => <Resync />`),
// which gets its own fiber underneath the memoized call. Measured in the browser by A24: three
// provider drivers frozen at `phase: "synchronizing"`, `query: ""`, forever; 0 catalog rows on
// `$`, `#` and `/`.
//
// THE FIX under test: the body is mounted as `createElement(render)` — its own component instance,
// its own fiber, inside the plugin's boundary + `<Suspense>` — so the memoized element is created
// once while the component behind it re-renders on its own subscriptions.
//
// HOW IT IS DRIVEN. `apps/web`'s unit project runs in the NODE environment and this repo has no
// jsdom, happy-dom or react-test-renderer (see `renderSafety.test.tsx`'s header), and a bug about
// RE-rendering cannot be pinned by `renderToStaticMarkup`, which mounts a fresh tree — and a fresh
// memo cache — on every call. So the file installs the ~40-line DOM stub below: the whole plugin
// background surface renders NOTHING (every component returns `null`), so `react-dom/client` needs
// no real element implementation, only a container it can attach to. That makes `createRoot` +
// `act` usable, and with them the four properties the browser found missing.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";
import { Suspense, useRef } from "react";
import { create } from "zustand";

import type { PluginComposerRow } from "@smart-tools/plugin-sdk/host";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";

import { RenderErrorBoundary } from "~/components/RenderErrorBoundary";

import { composerProviderDriverBody, PluginBackgroundSurface } from "./PluginBackgroundSurface";
import {
  pluginComposerProviderItems,
  resetPluginComposerProviders,
  setActiveComposerQuery,
} from "./composerProviders";
import { registerComposerProvider } from "./composerRegistry";
import { makeWebPluginHost } from "./hostApi";
import { resetPluginProblems } from "./problems";
import { resetPluginRenderFaultReports, safePluginBackgroundRender } from "./renderSafety";
import { recordPluginDisplayName, resetPluginDisplayNames } from "./status";
import { resetRegisteredOverlayPanels } from "../skills-agents/rightGlobalPanel/registry";

// The connection phase is the app's own projection over the supervisor state; what a unit suite
// cannot do is open a real websocket, so the ONE query hook underneath `useConnectionPhase` is
// driven from a store here. Everything above it — `usePluginConnectionPhase`, the host object, the
// driver — is the real code.
const useConnectionState = create<{ readonly state: SupervisorConnectionState | null }>(() => ({
  state: null,
}));

vi.mock("~/state/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/query")>();
  return {
    ...actual,
    useEnvironmentQuery: () => ({
      data: useConnectionState((store) => store.state),
      error: null,
      isPending: false,
      refresh: () => {},
    }),
  };
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The DOM stub. Enough of a container for `react-dom/client` to mount a tree that draws nothing.
// ─────────────────────────────────────────────────────────────────────────────────────────────

class StubElement {
  nodeType = 1;
  parentNode: unknown = null;
  childNodes: unknown[] = [];
  ownerDocument: unknown = null;
  style: Record<string, string> = { animation: "", transition: "" };
  namespaceURI = "http://www.w3.org/1999/xhtml";
  constructor(public nodeName = "DIV") {}
  get tagName(): string {
    return this.nodeName;
  }
  get firstChild(): unknown {
    return this.childNodes[0] ?? null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  setAttribute(): void {}
  removeAttribute(): void {}
  appendChild(child: { parentNode: unknown }): unknown {
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  insertBefore(child: { parentNode: unknown }): unknown {
    return this.appendChild(child);
  }
  removeChild(child: unknown): unknown {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    return child;
  }
}

/** `getActiveElementDeep` walks `activeElement instanceof HTMLIFrameElement`; ours is never one. */
class StubIFrame extends StubElement {
  contentWindow: unknown = null;
}

type Globals = Record<string, unknown>;
const stubbed: string[] = [];
let render: (node: ReactNode) => Promise<void>;
let unmount: () => Promise<void>;
let actImpl: (scope: () => Promise<void> | void) => Promise<void>;

beforeAll(async () => {
  const globals = globalThis as unknown as Globals;
  const document = new StubElement("#document") as unknown as Globals;
  document["nodeType"] = 9;
  document["createElement"] = (name: string) => new StubElement(name.toUpperCase());
  document["createTextNode"] = () => new StubElement("#text");
  document["createComment"] = () => new StubElement("#comment");
  document["documentElement"] = new StubElement("HTML");
  document["body"] = new StubElement("BODY");
  document["activeElement"] = null;
  for (const [key, value] of Object.entries({
    document,
    window: globalThis,
    IS_REACT_ACT_ENVIRONMENT: true,
    Element: StubElement,
    HTMLElement: StubElement,
    Node: StubElement,
    HTMLIFrameElement: StubIFrame,
  })) {
    if (globals[key] === undefined) stubbed.push(key);
    globals[key] = value;
  }

  // Imported only AFTER the stub is installed: `react-dom/client` reads `document` at module
  // evaluation (`getVendorPrefixedEventName`).
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const container = new StubElement();
  container.ownerDocument = document;
  const root = createRoot(container as unknown as Element);
  render = async (node) => {
    await act(async () => {
      root.render(node);
    });
  };
  unmount = async () => {
    await act(async () => {
      root.unmount();
    });
  };
  // `act` is also what every store change below is wrapped in.
  actImpl = act;
});

afterAll(async () => {
  await unmount();
  const globals = globalThis as unknown as Globals;
  for (const key of stubbed) delete globals[key];
});

const change = async (mutate: () => void): Promise<void> => {
  await actImpl(async () => {
    mutate();
  });
};

const row = (name: string): PluginComposerRow => ({
  name,
  label: name,
  description: `${name} skill`,
  insert: `skill:⟦${name}⟧ `,
});

beforeEach(() => {
  resetPluginComposerProviders();
  resetPluginProblems();
  resetPluginRenderFaultReports();
  resetPluginDisplayNames();
  resetRegisteredOverlayPanels();
  useConnectionState.setState({ state: null });
  recordPluginDisplayName("catalogs", "Skills, Agents & Commands");
});

const names = (trigger: "skill" | "agent" | "command"): readonly string[] =>
  pluginComposerProviderItems(trigger).map((item) => item.name);

describe("a composer provider driver is its own live component (A24 H1)", () => {
  it("re-renders when a store its useRows reads changes", async () => {
    // The catalogs plugin's shape: `useRows` reads the plugin's own reactive state (there, an
    // atom filled by a `plugin.invoke` snapshot; here, a zustand store) and derives its rows.
    const useCatalog = create<{ readonly items: readonly string[] }>(() => ({ items: ["auth"] }));
    registerComposerProvider("catalogs", {
      trigger: "skill",
      useRows: (query) =>
        useCatalog((store) => store.items)
          .filter((name) => name.includes(query))
          .map(row),
    });

    await render(<PluginBackgroundSurface />);
    expect(names("skill")).toEqual(["auth"]);

    // The defect: before the fix the rows stayed `["auth"]` here forever — the driver's hooks had
    // run once, on the mount render, and the store's notification reached a component that the
    // compiled body never called again.
    await change(() => {
      useCatalog.setState({ items: ["auth", "deploy"] });
    });
    expect(names("skill")).toEqual(["auth", "deploy"]);

    // And the other direction: a snapshot that loses an item loses its row.
    await change(() => {
      useCatalog.setState({ items: ["deploy"] });
    });
    expect(names("skill")).toEqual(["deploy"]);
  });

  it("re-runs useRows with the query the composer publishes", async () => {
    const seen: string[] = [];
    const useCatalog = create<{ readonly items: readonly string[] }>(() => ({
      items: ["global-auth", "global-deploy", "local-lint"],
    }));
    registerComposerProvider("catalogs", {
      trigger: "skill",
      useRows: (query) => {
        seen.push(query);
        return useCatalog((store) => store.items)
          .filter((name) => name.includes(query))
          .map(row);
      },
    });

    await render(<PluginBackgroundSurface />);
    // A driver with no menu open is driven at the EMPTY query — that is what primes the command
    // slug set (plan §6 P5), and it is why `seen[0]` is `""`.
    expect(seen[0]).toBe("");
    expect(names("skill")).toHaveLength(3);

    // `$gl` in the browser: `ChatComposer` publishes the trigger and the query, the driver
    // re-renders, `useRows` runs again with `"gl"`.
    await change(() => {
      setActiveComposerQuery("skill", "gl");
    });
    expect(seen.at(-1)).toBe("gl");
    expect(names("skill")).toEqual(["global-auth", "global-deploy"]);

    // Another trigger's menu is not this provider's business: the argument goes back to `""`.
    await change(() => {
      setActiveComposerQuery("command", "gl");
    });
    expect(seen.at(-1)).toBe("");
    expect(names("skill")).toHaveLength(3);
  });

  it("sees host.hooks.useConnectionPhase change while it is mounted", async () => {
    // A23's readiness gate: the catalogs plugin primes its catalog when the phase reaches
    // `"ready"`. With the driver frozen the phase stayed at its mount value and the gate never
    // fired — zero `plugin.invoke:*.snapshot` calls in A24's WS tally, so every row was `[]`.
    const { host } = makeWebPluginHost({ id: "catalogs", name: "Skills, Agents & Commands" });
    const phases: string[] = [];
    registerComposerProvider("catalogs", {
      trigger: "agent",
      useRows: () => {
        const phase = host.hooks.useConnectionPhase();
        phases.push(phase);
        return phase === "ready" ? [row("general-purpose")] : [];
      },
    });

    await render(<PluginBackgroundSurface />);
    expect(phases.at(-1)).toBe("disconnected");
    expect(names("agent")).toEqual([]);

    await change(() => {
      useConnectionState.setState({
        state: { ...AVAILABLE_CONNECTION_STATE, phase: "connecting" },
      });
    });
    expect(phases.at(-1)).toBe("synchronizing");

    await change(() => {
      useConnectionState.setState({
        state: { ...AVAILABLE_CONNECTION_STATE, phase: "connected" },
      });
    });
    expect(phases.at(-1)).toBe("ready");
    expect(names("agent")).toEqual(["general-purpose"]);
  });

  it("mounts two providers on one trigger as independent instances", async () => {
    // Two providers per trigger per plugin is the documented cap, and each has to be its own
    // component: its own hook state, its own subscriptions, its own rows in the store. When both
    // shared `PluginBackgroundBody`'s fiber this was structurally impossible.
    const useFirst = create<{ readonly items: readonly string[] }>(() => ({ items: ["first"] }));
    const useSecond = create<{ readonly items: readonly string[] }>(() => ({ items: ["second"] }));
    const identities = { first: new Set<unknown>(), second: new Set<unknown>() };
    const renders = { first: 0, second: 0 };

    registerComposerProvider("catalogs", {
      trigger: "skill",
      useRows: () => {
        renders.first += 1;
        identities.first.add(useRef({}).current);
        return useFirst((store) => store.items).map(row);
      },
    });
    registerComposerProvider("catalogs", {
      trigger: "skill",
      useRows: () => {
        renders.second += 1;
        identities.second.add(useRef({}).current);
        return useSecond((store) => store.items).map(row);
      },
    });

    await render(<PluginBackgroundSurface />);
    expect(names("skill")).toEqual(["first", "second"]);
    // Each provider's `useRef` is stable across its own renders — one instance, not a shared one —
    // and the two rows land under two keys, in registration order.
    const afterMount = { ...renders };

    await change(() => {
      useFirst.setState({ items: ["first", "first-b"] });
    });
    expect(names("skill")).toEqual(["first", "first-b", "second"]);
    // The second provider did not re-render for the first one's store: separate fibers, separate
    // subscriptions. (A shared fiber would have re-run both hooks on every notification.)
    expect(renders.second).toBe(afterMount.second);
    expect(renders.first).toBeGreaterThan(afterMount.first);

    await change(() => {
      useSecond.setState({ items: ["second-only"] });
    });
    expect(names("skill")).toEqual(["first", "first-b", "second-only"]);
    expect(identities.first.size).toBe(1);
    expect(identities.second.size).toBe(1);
  });
});

describe("the host MOUNTS a background body, it never calls it (the H1 invariant)", () => {
  // THE ONE CASE THE FOUR ABOVE CANNOT COVER. React Compiler is what turned "called during the
  // host's render" into "called once, ever", and it does not run here:
  // `reactCompilerPreset().rolldown.applyToEnvironmentHook` is `env.config.consumer === "client"`,
  // while `apps/web`'s unit project is a NODE consumer. So the four behavioural tests pass on the
  // BROKEN code too — verified before the fix landed — and the defect is only visible in the built
  // client bundle (A24 measured it there, `evidence/phase3-parity-fix/`).
  //
  // What IS checkable in Node is the structure that made the compiler's memoization fatal: whether
  // the plugin's body reaches React as an ELEMENT (its own fiber) or as the RESULT of a call made
  // on the host's fiber. This walks the real wrapper `safePluginBackgroundRender` builds and pins
  // exactly that — and it fails on the old code, where the body is invoked and its `useRows` hook
  // call throws "Invalid hook call" outside a render.
  const child = (node: unknown): unknown =>
    (node as { readonly props: { readonly children: unknown } }).props.children;
  const invoke = (node: unknown): unknown => {
    const element = node as { readonly type: (props: unknown) => unknown; readonly props: unknown };
    return element.type(element.props);
  };

  it("hands React an element whose type is the plugin's own body", () => {
    const body = composerProviderDriverBody({
      key: "provider:catalogs:skill:0",
      pluginId: "catalogs",
      trigger: "skill",
      useRows: () => [row("auth")],
    });

    // `() => <PluginBackgroundBoundary … />` → `<RenderErrorBoundary><Suspense><PluginBackgroundBody
    // render={body} /></Suspense></RenderErrorBoundary>` → what that body hands React.
    const boundary = safePluginBackgroundRender({
      pluginId: "catalogs",
      pluginName: "Skills, Agents & Commands",
      surface: "composer-provider",
      render: body,
    })();
    const mounted = invoke(child(child(invoke(boundary))));

    // A FRAGMENT holding an ELEMENT of the body — not the body's return value. `null` here (the
    // body's own answer) would mean it had already been called on somebody else's fiber.
    const node = child(mounted) as { readonly type: unknown };
    expect(node.type).toBe(body);

    // The boundary and the Suspense are still outside it: a throw in `useRows` is the plugin's,
    // and a suspension inside it does not suspend the app shell.
    const tree = invoke(boundary) as { readonly type: unknown };
    expect(tree.type).toBe(RenderErrorBoundary);
    expect((child(tree) as { readonly type: unknown }).type).toBe(Suspense);
  });

  it("mounts a background view's body the same way — the SDK's `() => <Resync />` still works", () => {
    const Resync = (): ReactNode => null;
    const view = () => <Resync />;
    const boundary = safePluginBackgroundRender({
      pluginId: "catalogs",
      pluginName: "Skills, Agents & Commands",
      surface: "background-view",
      render: view,
    })();

    const mounted = invoke(child(child(invoke(boundary))));
    const node = child(mounted) as { readonly type: unknown };
    // The view function is now a component instance of its own, and `Resync` is one fiber deeper —
    // which is what a background view that holds its hooks DIRECTLY (no inner component) needed.
    expect(node.type).toBe(view);
    expect((invoke(node) as { readonly type: unknown }).type).toBe(Resync);
  });
});
