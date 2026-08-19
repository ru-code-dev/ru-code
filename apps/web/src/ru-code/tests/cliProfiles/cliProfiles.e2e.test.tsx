// ru-code: END-TO-END coverage of the brand-profile pipeline (no ACP needed for this
// feature). Injects server-shaped state — provider snapshots + persisted settings for
// 1–2 qwen instances — runs the REAL server→UI projection (deriveProviderInstanceEntries
// + applyProviderInstanceSettings), and asserts the resulting picker entries carry the
// right profile AND the REAL ProviderInstanceIcon renders the matching mark. Drives the
// add + edit flows so we know the UI and the server-shaped config agree end to end.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../../providerInstances";
import { ProviderInstanceIcon } from "../../../components/chat/ProviderInstanceIcon";

const QWEN = ProviderDriverKind.make("qwen");

function snapshot(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: QWEN,
    displayName,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

const envelope = (profile: "custom" | "qwen"): ProviderInstanceConfig => ({
  driver: QWEN,
  enabled: true,
  config: { profile },
});

function settings(
  instances: Record<string, ProviderInstanceConfig>,
): Pick<ServerSettings, "providerInstances" | "providers"> {
  const providerInstances: Record<string, ProviderInstanceConfig> = {};
  for (const [id, env] of Object.entries(instances)) {
    providerInstances[ProviderInstanceId.make(id)] = env;
  }
  return {
    providerInstances: providerInstances as ServerSettings["providerInstances"],
    providers: {} as ServerSettings["providers"],
  };
}

/** The real server→UI projection. */
const project = (
  snaps: ServerProvider[],
  cfg: Pick<ServerSettings, "providerInstances" | "providers">,
): ReadonlyArray<ProviderInstanceEntry> =>
  applyProviderInstanceSettings(deriveProviderInstanceEntries(snaps), cfg);

const byId = (entries: ReadonlyArray<ProviderInstanceEntry>, id: string): ProviderInstanceEntry =>
  entries.find((e) => e.instanceId === ProviderInstanceId.make(id))!;

/** Render the REAL provider icon exactly as a picker/card would for an entry. */
const iconMark = (entry: ProviderInstanceEntry): string =>
  renderToStaticMarkup(
    <ProviderInstanceIcon
      driverKind={entry.driverKind}
      profile={entry.profile}
      displayName={entry.displayName}
    />,
  );

describe("brand profiles — e2e: server state → UI projection → rendered icon", () => {
  it("two qwen instances project to their own profiles and marks", () => {
    const entries = project(
      [snapshot("qwen", "Custom Code"), snapshot("qwen_stock", "Qwen Code")],
      settings({ qwen: envelope("custom"), qwen_stock: envelope("qwen") }),
    );

    const fork = byId(entries, "qwen");
    const stock = byId(entries, "qwen_stock");
    expect(fork.profile).toBe("custom");
    expect(stock.profile).toBe("qwen");
    expect(iconMark(fork)).toContain('data-cli-profile="custom"');
    expect(iconMark(stock)).toContain('data-cli-profile="qwen"');
  });

  it("the default instance with no persisted config defaults to the custom profile", () => {
    const dflt = byId(project([snapshot("qwen", "Custom Code")], settings({})), "qwen");
    expect(dflt.profile).toBe("custom");
    expect(dflt.enabled).toBe(true);
    expect(iconMark(dflt)).toContain('data-cli-profile="custom"');
  });

  it("EDIT: flipping an instance's profile re-projects to the new mark", () => {
    const snaps = [snapshot("qwen_stock", "Qwen Code")];

    const before = byId(project(snaps, settings({ qwen_stock: envelope("qwen") })), "qwen_stock");
    expect(before.profile).toBe("qwen");
    expect(iconMark(before)).toContain('data-cli-profile="qwen"');

    // user edits the instance on the card → its config.profile flips to custom
    const after = byId(project(snaps, settings({ qwen_stock: envelope("custom") })), "qwen_stock");
    expect(after.profile).toBe("custom");
    expect(iconMark(after)).toContain('data-cli-profile="custom"');
  });

  it("ADD: a newly added qwen instance surfaces with its chosen profile + mark", () => {
    const base = [snapshot("qwen", "Custom Code")];
    expect(project(base, settings({ qwen: envelope("custom") }))).toHaveLength(1);

    // the add-provider dialog created a second qwen instance with the "qwen" profile
    const withAdded = project(
      [...base, snapshot("qwen_stock", "Qwen Code")],
      settings({ qwen: envelope("custom"), qwen_stock: envelope("qwen") }),
    );
    expect(withAdded).toHaveLength(2);
    const added = byId(withAdded, "qwen_stock");
    expect(added.profile).toBe("qwen");
    expect(added.enabled).toBe(true);
    expect(iconMark(added)).toContain('data-cli-profile="qwen"');
    // the pre-existing fork instance is untouched
    expect(byId(withAdded, "qwen").profile).toBe("custom");
  });
});
