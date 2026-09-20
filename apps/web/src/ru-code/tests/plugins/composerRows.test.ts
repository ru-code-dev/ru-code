// ru-code v2: the composer's translation layer — the app's trigger vocabulary, the row shape its
// menu renders, the per-plugin sections, and the `/`-slug set the qwen submit guard reads.
import type { ComposerRow, WebCtx } from "@smart-tools/plugin-sdk/host";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerCommandItem } from "~/components/chat/ComposerCommandMenu";

import { stripUnknownLeadingSlashCommand } from "../../slash-commands/qwenSlashCommands";

import {
  groupPluginComposerItems,
  mergePluginComposerRows,
  pluginCommandSlugs,
  toComposerCommandItem,
  toPluginTrigger,
} from "../../plugins/composerRows";
import type { PluginContribution } from "../../plugins/seams";

const contribution = (pluginId: string, row: ComposerRow): PluginContribution<ComposerRow> => ({
  pluginId,
  pluginName: pluginId.toUpperCase(),
  key: `plugin:${pluginId}:/:${row.id}`,
  value: row,
  ctx: {} as WebCtx,
});

const nameOf = (pluginId: string) => pluginId.toUpperCase();

describe("toPluginTrigger", () => {
  it("maps the app's kinds onto the characters the SDK speaks", () => {
    expect(toPluginTrigger("slash-command")).toBe("/");
    expect(toPluginTrigger("skill")).toBe("$");
    expect(toPluginTrigger("subagent")).toBe("#");
  });

  it("has no plugin trigger for the path picker or for a closed menu", () => {
    // A file picker is the app's own index, not a menu a plugin contributes to.
    expect(toPluginTrigger("path")).toBeNull();
    expect(toPluginTrigger(null)).toBeNull();
  });
});

describe("toComposerCommandItem", () => {
  it("carries the row through unchanged, with the app's own trigger name", () => {
    const item = toComposerCommandItem(
      contribution("notes", {
        id: "add",
        label: "Add note",
        description: "Append to the notes",
        insert: "/notes-add ",
        icon: "Puzzle",
        group: "Project",
      }),
      "/",
    );
    expect(item).toMatchObject({
      type: "plugin-item",
      trigger: "command",
      pluginId: "notes",
      label: "Add note",
      description: "Append to the notes",
      insert: "/notes-add ",
      icon: "Puzzle",
      group: "Project",
    });
  });

  it("omits the optional fields rather than filling them in", () => {
    const item = toComposerCommandItem(
      contribution("n", { id: "a", label: "A", insert: "x" }),
      "$",
    );
    expect(item).toMatchObject({ type: "plugin-item", trigger: "skill", description: "" });
    expect("icon" in item).toBe(false);
    expect("group" in item).toBe(false);
  });
});

describe("mergePluginComposerRows", () => {
  it("puts plugin rows FIRST", () => {
    const plugin = [{ id: "p", type: "plugin-item" } as ComposerCommandItem];
    const native = [{ id: "n", type: "slash-command" } as ComposerCommandItem];
    expect(mergePluginComposerRows(plugin, native).map((item) => item.id)).toEqual(["p", "n"]);
  });
});

describe("groupPluginComposerItems", () => {
  const item = (over: Partial<ComposerCommandItem> & { pluginId: string; id: string }) =>
    ({
      type: "plugin-item",
      trigger: "command",
      label: over.id,
      description: "",
      insert: `/${over.id} `,
      ...over,
    }) as ComposerCommandItem;

  it("labels a section with the plugin's display name when the row names none", () => {
    const groups = groupPluginComposerItems(
      [item({ pluginId: "notes", id: "a" }), item({ pluginId: "notes", id: "b" })],
      nameOf,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("NOTES");
    expect(groups[0]?.items).toHaveLength(2);
  });

  it("lets a row name its own section", () => {
    const groups = groupPluginComposerItems(
      [
        item({ pluginId: "cat", id: "a", group: "Project" }),
        item({ pluginId: "cat", id: "b", group: "Global" }),
        item({ pluginId: "cat", id: "c", group: "Project" }),
      ],
      nameOf,
    );
    expect(groups.map((group) => group.label)).toEqual(["Project", "Global"]);
    expect(groups[0]?.items).toHaveLength(2);
  });

  it("never merges two plugins' sections even when they choose the same label", () => {
    // Otherwise one plugin's rows appear under a heading another plugin wrote.
    const groups = groupPluginComposerItems(
      [
        item({ pluginId: "a", id: "x", group: "Project" }),
        item({ pluginId: "b", id: "y", group: "Project" }),
      ],
      nameOf,
    );
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((group) => group.id)).size).toBe(2);
  });

  it("keeps first-appearance order and ignores the app's own rows", () => {
    const groups = groupPluginComposerItems(
      [
        { id: "native", type: "slash-command" } as ComposerCommandItem,
        item({ pluginId: "z", id: "1" }),
        item({ pluginId: "a", id: "2" }),
      ],
      nameOf,
    );
    expect(groups.map((group) => group.label)).toEqual(["Z", "A"]);
  });
});

describe("pluginCommandSlugs", () => {
  const commandRow = (insert: string): ComposerCommandItem =>
    ({
      id: insert,
      type: "plugin-item",
      trigger: "command",
      pluginId: "cat",
      label: insert,
      description: "",
      insert,
    }) as ComposerCommandItem;

  it("derives the slug from what the row would PASTE", () => {
    expect([...pluginCommandSlugs([commandRow("/review "), commandRow("/ship-it")])]).toEqual([
      "review",
      "ship-it",
    ]);
  });

  // ru-code S40 F4 (REVIEW): the allowlist and the guard must read the SAME slug out of a row.
  //
  // `pluginCommandSlugs` builds the set with `/^\/([A-Za-z0-9_:-]+)/`; the submit guard reads the
  // typed command with `/^\/(\S+)/` (`qwenSlashCommands.ts` `LEADING_SLASH_COMMAND`), which is
  // what qwen itself accepts. Any command name outside that ASCII charset — a Cyrillic one in the
  // app's own Russian locale, a dotted one — makes the two disagree, so the row is offered in the
  // menu, the user picks it, and the submit is ABORTED as an unknown `/command`. That is the S11
  // defect verbatim, for a name the catalogs plugin takes straight off the user's own
  // `.qwen/commands/<name>.toml` (`plugin-catalogs/src/web/composer.ts` `insert: /${name} `).
  it("S40 F4: a command the row offers is one the submit guard lets through", () => {
    for (const insert of ["/сборка ", "/deploy.prod "]) {
      const allowed = pluginCommandSlugs([commandRow(insert)]);
      const typed = insert.trim();
      expect([typed, stripUnknownLeadingSlashCommand(typed, allowed)]).toEqual([typed, typed]);
    }
  });

  // The parity the ONE reader buys, as a table. A command name is anything without whitespace —
  // qwen's own rule (`command-factory.ts` derives the name from the file path,
  // `slashCommandProcessor.ts` splits the line on `/\s+/u`) — so every spelling below is a name a
  // user's `.qwen/commands/<name>.toml` can carry and the catalogs plugin will offer. For each,
  // the slug the allowlist holds IS the slug the submit guard looks up, bare and with arguments.
  it("S40 F4: allowlist and guard read the same slug out of every name qwen accepts", () => {
    const names = [
      "review", // Latin
      "сборка", // Cyrillic — the app's own default locale
      "deploy.prod", // dotted
      "fs:ls", // colon-namespaced
      "Release", // upper-case: the one reader lower-cases, both sides
      "план-б", // Cyrillic with a hyphen
    ];
    for (const name of names) {
      const allowed = pluginCommandSlugs([commandRow(`/${name} `)]);
      expect([...allowed], `slug for /${name}`).toEqual([name.toLowerCase()]);
      for (const typed of [`/${name}`, `/${name} второй аргумент`]) {
        expect(stripUnknownLeadingSlashCommand(typed, allowed), `guard on ${typed}`).toBe(typed);
      }
    }
  });

  it("lower-cases, so the guard's comparison cannot miss on case", () => {
    expect(pluginCommandSlugs([commandRow("/Review ")]).has("review")).toBe(true);
  });

  it("ignores rows of the other triggers and rows that paste something else", () => {
    const skillRow = {
      id: "/x",
      type: "plugin-item",
      trigger: "skill",
      pluginId: "cat",
      label: "x",
      description: "",
      insert: "/x",
    } as ComposerCommandItem;
    expect(pluginCommandSlugs([skillRow, commandRow("just text")]).size).toBe(0);
  });

  it("is empty with no plugin rows at all — the unknown-command behaviour", () => {
    expect(pluginCommandSlugs([]).size).toBe(0);
  });
});
