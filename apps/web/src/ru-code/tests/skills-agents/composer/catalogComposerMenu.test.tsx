import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import type { CatalogItem } from "@smart-tools/qwen-cli-catalog-core/contracts";

import {
  catalogSkillMenuItems,
  catalogAgentMenuItems,
  catalogCommandMenuItems,
} from "../../../skills-agents/composer/catalogMenuItems";
import { groupCatalogComposerItems } from "../../../skills-agents/composer/groupCatalogComposerItems";
import {
  BUILTIN_AGENT_ITEMS,
  filterBuiltinAgents,
} from "../../../skills-agents/composer/builtinAgents";
import { ComposerCommandMenu } from "../../../../components/chat/ComposerCommandMenu";
import type { ComposerCommandItem } from "../../../../components/chat/ComposerCommandMenu";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

const item = (
  name: string,
  bindings: CatalogItem["bindings"],
  description?: string,
): CatalogItem => ({
  id: `id-${name}`,
  name,
  description,
  canonicalHash: `hash-${name}`,
  files: [],
  origins: [],
  bindings,
  diverged: false,
});

// bound + enabled to the active project → "project" scope
const projectItem = item("proj-skill", [
  { scope: "project", projectId: PROJECT_ID, enabled: true },
]);
// bound + enabled globally only → "global" scope
const globalItem = item("global-skill", [{ scope: "global", enabled: true }]);

describe("W2 — catalog*MenuItems scope bucketing", () => {
  it("assigns project scope only for the active project, global otherwise", () => {
    const rows = catalogSkillMenuItems([projectItem, globalItem], PROJECT_ID);
    expect(rows.find((r) => r.name === "proj-skill")!.scope).toBe("project");
    expect(rows.find((r) => r.name === "global-skill")!.scope).toBe("global");
  });

  it("a project-bound item is GLOBAL scope when a different project is active", () => {
    const rows = catalogSkillMenuItems([projectItem], "99999999-9999-9999-9999-999999999999");
    expect(rows[0]!.scope).toBe("global");
  });

  it("formats the visible label but keeps the raw name (identity)", () => {
    const rows = catalogAgentMenuItems(
      [item("code-reviewer", [{ scope: "global", enabled: true }])],
      null,
    );
    expect(rows[0]!.label).toBe("Code Reviewer");
    expect(rows[0]!.name).toBe("code-reviewer");
    expect(rows[0]!.id).toBe("catalog-agent:code-reviewer");
  });

  it("shows the RAW name when two rows would format identically (look-alike)", () => {
    const rows = catalogSkillMenuItems(
      [
        item("my-skill", [{ scope: "global", enabled: true }]),
        item("my_skill", [{ scope: "global", enabled: true }]),
      ],
      null,
    );
    expect(rows.map((r) => r.label).sort()).toEqual(["my-skill", "my_skill"]);
  });
});

describe("W3 — groupCatalogComposerItems", () => {
  const mk = (name: string, scope: "project" | "global" | "builtin"): ComposerCommandItem => ({
    id: `catalog-skill:${name}`,
    type: "catalog-skill",
    name,
    label: name,
    description: "d",
    scope,
  });

  it("returns the three sections in order, omitting empties", () => {
    const groups = groupCatalogComposerItems([
      mk("g1", "global"),
      mk("p1", "project"),
      mk("b1", "builtin"),
      mk("g2", "global"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Проект", "Глобальные", "Встроенные"]);
    expect(groups[1]!.items.map((i) => i.id)).toEqual(["catalog-skill:g1", "catalog-skill:g2"]);
  });

  it("omits a section with no items", () => {
    const groups = groupCatalogComposerItems([mk("g1", "global")]);
    expect(groups.map((g) => g.label)).toEqual(["Глобальные"]);
  });

  it("returns [] for non-catalog items (native/fallback path)", () => {
    const native: ComposerCommandItem = {
      id: "slash:model",
      type: "slash-command",
      command: "model",
      label: "/model",
      description: "d",
    };
    expect(groupCatalogComposerItems([native])).toEqual([]);
  });
});

describe("W4 — built-in agents", () => {
  it("exposes exactly general-purpose + Explore, all scope builtin", () => {
    expect(BUILTIN_AGENT_ITEMS.map((a) => a.name)).toEqual(["general-purpose", "Explore"]);
    expect(BUILTIN_AGENT_ITEMS.every((a) => a.scope === "builtin")).toBe(true);
    expect(BUILTIN_AGENT_ITEMS.every((a) => a.type === "catalog-agent")).toBe(true);
  });

  it("filters by query on name or label", () => {
    expect(filterBuiltinAgents("").length).toBe(2);
    expect(filterBuiltinAgents("expl").map((a) => a.name)).toEqual(["Explore"]);
    expect(filterBuiltinAgents("general").map((a) => a.name)).toEqual(["general-purpose"]);
    expect(filterBuiltinAgents("General Pur").map((a) => a.name)).toEqual(["general-purpose"]); // label
    expect(filterBuiltinAgents("zzz")).toEqual([]);
  });
});

describe("R3 — ComposerCommandMenu renders the 3-section catalog picker", () => {
  const renderMenu = (items: ComposerCommandItem[], triggerKind: "skill" | "subagent") =>
    renderToStaticMarkup(
      <ComposerCommandMenu
        items={items}
        resolvedTheme="light"
        isLoading={false}
        triggerKind={triggerKind}
        activeItemId={null}
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

  it("skill picker shows Проект + Глобальные section headers with formatted labels", () => {
    const items = catalogSkillMenuItems([projectItem, globalItem], PROJECT_ID);
    const html = renderMenu([...items], "skill");
    expect(html).toContain("Проект");
    expect(html).toContain("Глобальные");
    expect(html).toContain("Proj Skill"); // formatted project row
    expect(html).toContain("Global Skill"); // formatted global row
  });

  it("agent picker merges catalog + built-ins into three sections", () => {
    const items: ComposerCommandItem[] = [
      ...catalogAgentMenuItems([globalItem], PROJECT_ID),
      ...filterBuiltinAgents(""),
    ];
    const html = renderMenu(items, "subagent");
    expect(html).toContain("Глобальные");
    expect(html).toContain("Встроенные");
    expect(html).toContain("General Purpose"); // built-in, formatted
    expect(html).toContain("Explore");
  });
});

describe("commands — catalogCommandMenuItems + `/` grouping", () => {
  it("label is /name, id is catalog-command:<name>, and scope buckets like skills", () => {
    const rows = catalogCommandMenuItems(
      [
        item("deploy", [{ scope: "project", projectId: PROJECT_ID, enabled: true }], "Deploy it"),
        item("review", [{ scope: "global", enabled: true }]),
      ],
      PROJECT_ID,
    );
    const deploy = rows.find((r) => r.name === "deploy")!;
    expect(deploy.type).toBe("catalog-command");
    expect(deploy.label).toBe("/deploy"); // the invocation token
    expect(deploy.id).toBe("catalog-command:deploy");
    expect(deploy.description).toBe("Deploy it");
    expect(deploy.scope).toBe("project");
    expect(rows.find((r) => r.name === "review")!.scope).toBe("global");
  });

  it("groups catalog commands into Проект / Глобальные under the `/` trigger", () => {
    const rows: ComposerCommandItem[] = [
      ...catalogCommandMenuItems(
        [
          item("deploy", [{ scope: "project", projectId: PROJECT_ID, enabled: true }]),
          item("review", [{ scope: "global", enabled: true }]),
        ],
        PROJECT_ID,
      ),
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "x",
      },
    ];
    // renders without throwing; the catalog rows carry their scope for section grouping.
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={rows}
        resolvedTheme="light"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId={null}
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(markup).toContain("/deploy");
    expect(markup).toContain("/review");
    expect(markup).toContain("/model");
    const grouped = groupCatalogComposerItems(rows);
    expect(grouped.map((g) => g.label)).toEqual(["Проект", "Глобальные"]);
  });
});
