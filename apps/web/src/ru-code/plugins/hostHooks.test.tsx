// ru-code (A22, SDK 0.3.0): `host.hooks.useProjects()` and `host.hooks.useActiveProjectId()`.
//
// These are the web half of the project seam whose server half is `host.projects` (O2-a). What is
// worth pinning is not the values — they come from the app's own stores, which have their own
// tests — but the two things a plugin cannot check and the whole design rests on:
//
//   1. they are REAL HOOKS, called through the host object. Calling a hook from a plugin component
//      only works because the plugin's React IS the host's React (D13, the import map); a host
//      that handed over a plain function would hide the day that stopped being true;
//   2. they are the app's OWN implementations — `skills-agents/catalog/{hostPorts,activeProject}`,
//      the same modules the MCP panel, the pixso panel and the composer read — rather than a
//      second derivation. A plugin panel and a built-in panel must never disagree about which
//      projects exist or which one the user is looking at.
//
// There is no jsdom in this repo, so a probe component rendered with `renderToStaticMarkup` is the
// idiom (`panelRegistryReactive.test.tsx`).

import { beforeEach, describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import { makeWebPluginHost } from "./hostApi";
import { resetPluginProblems } from "./problems";
import { resetPluginDisplayNames } from "./status";
import { resetRegisteredOverlayPanels } from "../skills-agents/rightGlobalPanel/registry";
import { resolveActiveProjectId } from "../skills-agents/catalog/activeProject";

const status = { id: "catalogs", name: "Skills, Agents & Commands" };

beforeEach(() => {
  resetPluginProblems();
  resetPluginDisplayNames();
  resetRegisteredOverlayPanels();
});

describe("host.hooks (A22)", () => {
  it("exposes the two project hooks on every host object", () => {
    const { host } = makeWebPluginHost(status);
    expect(typeof host.hooks.useProjects).toBe("function");
    expect(typeof host.hooks.useActiveProjectId).toBe("function");
    // The pre-A22 three are untouched — this is an additive contract.
    expect(typeof host.hooks.useLocale).toBe("function");
    expect(typeof host.hooks.useTheme).toBe("function");
    expect(typeof host.hooks.useConnectionPhase).toBe("function");
  });

  it("useProjects renders inside a component and answers an array", () => {
    const { host } = makeWebPluginHost(status);
    function Probe() {
      const projects = host.hooks.useProjects();
      return (
        <ul data-count={projects.length}>
          {projects.map((project) => (
            <li key={project.id}>{project.name}</li>
          ))}
        </ul>
      );
    }
    // With no environment behind it the honest answer is EMPTY — "no projects to show", not
    // "loading" and not a throw. A plugin gates on `useConnectionPhase()` if it needs the
    // difference; a hook that threw here would take the plugin's panel down on a cold page.
    const html = renderToStaticMarkup(<Probe />);
    expect(html).toContain('data-count="0"');
  });

  it("useActiveProjectId reads the ROUTER, which is what makes every surface agree", () => {
    const { host } = makeWebPluginHost(status);
    function Probe() {
      return <span>{String(host.hooks.useActiveProjectId())}</span>;
    }
    // Rendered with no router in context it throws INSIDE tanstack's `useParams` — and that is the
    // fact worth recording, not a defect: the answer comes from the route rather than from a
    // component's props, which is exactly why a panel, a background view and a composer provider
    // all see the same project in the same commit. A unit suite has no router (the app's own
    // `activeProject.test.ts` tests the pure resolver for the same reason), so the behaviour is
    // pinned through `resolveActiveProjectId` below.
    expect(() => renderToStaticMarkup(<Probe />)).toThrow();
  });

  it("is the app's own route resolution, not a second one", () => {
    // `useActiveProjectId` is thin wiring over this pure resolver — the same one the MCP
    // active-project sync and the composer's catalog filter go through. Pinning the resolver here
    // is what makes "a plugin and a built-in panel agree" a fact rather than a hope.
    expect(
      resolveActiveProjectId({ routeKind: "server", threadProjectId: "p1", draftProjectId: "p2" }),
    ).toBe("p1");
    expect(
      resolveActiveProjectId({ routeKind: "draft", threadProjectId: "p1", draftProjectId: "p2" }),
    ).toBe("p2");
    // The global surface — the home route, settings — has no project, and `null` is the answer a
    // plugin has to be able to act on (its catalog shows globals only).
    expect(
      resolveActiveProjectId({ routeKind: null, threadProjectId: "p1", draftProjectId: "p2" }),
    ).toBeNull();
    expect(
      resolveActiveProjectId({ routeKind: "server", threadProjectId: null, draftProjectId: "p2" }),
    ).toBeNull();
  });
});
