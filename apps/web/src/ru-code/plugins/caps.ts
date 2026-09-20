// ru-code v2: every per-plugin cap, in one file, with ONE counting rule.
//
// v1 had seven caps in four files counted three different ways — by distinct id, by call, by
// surface — plus label and toast length limits (audit finding L2). The rule here is uniform and
// stated once: a seam call may contribute at most N entries; the excess is DROPPED and the plugin
// is told once through the ordinary problem channel. Nothing throws, because a throw inside a seam
// call would cost the plugin a surface it got right.
//
// The numbers are deliberately small. They are not a security boundary — a plugin runs in the
// app's own page — they exist so a `for` loop an author writes by accident cannot push the sidebar
// off screen or wedge the tab, which v1 measured happening at 1 000 registrations.

import type { InvalidateSeam } from "@smart-tools/plugin-sdk/host";

/** Pages contributed by one plugin. Each is a route and a nav entry; a handful is a lot. */
export const MAX_PAGES_PER_PLUGIN = 8;

/** Panels contributed by one plugin. A panel is a sidebar icon. */
export const MAX_PANELS_PER_PLUGIN = 4;

/** Composer rows one plugin may contribute for ONE query. A menu is a list a human reads. */
export const MAX_COMPOSER_ROWS_PER_PLUGIN = 100;

/** Always-mounted background components. Each runs inside app chrome — keep it low. */
export const MAX_BACKGROUND_PER_PLUGIN = 2;

/**
 * `ctx.invoke` calls one plugin may hold PARKED — waiting for the transport to come up — at once
 * (S28, V2-35). A plugin that fires a call per render while the socket is down would otherwise
 * queue without bound; the excess rejects with `transport` and the plugin is told once.
 */
export const MAX_PARKED_INVOKES_PER_PLUGIN = 16;

/**
 * HOW a plugin's live values reach this tab (S69, V2-58) — the ONE switch between the state seam's
 * two engine transports. Plugins cannot see it and cannot pick: `ctx.state(name)` is the same
 * `Signal` with the same rules either way (the SDK's `@smart-tools/plugin-sdk/state`), and the server
 * serves both at once (`apps/server/src/ru-code/plugins/state.ts`), so this constant is the whole of
 * the choice and nothing needs a build flag.
 *
 *   · `"stream"` — `plugin.state`: the server PUSHES the value. A snapshot of every current value
 *     when the stream opens (and re-opens, on every reconnect), then each change, latest-wins.
 *   · `"notify"` — `plugin.notifications` carries the NAME, and this tab reads the value through
 *     `plugin.state.read`, one read in flight per name; on every edge back into `ready`, every name
 *     is read once.
 *
 * Both stay in production until the owner has compared them; the loser is removed then, not before.
 */
export const PLUGIN_STATE_TRANSPORT: "stream" | "notify" = "stream";

/** Longest title/label a plugin surface may carry, so a runaway string cannot break a layout. */
export const MAX_LABEL_LENGTH = 64;

/** Longest row description, and the ceiling on a toast body. */
export const MAX_DESCRIPTION_LENGTH = 1000;

/**
 * Control and format characters.
 *
 * They render as nothing, and the bidi overrides among them can make a label display text that is
 * not the text it contains — so a plugin string carrying one is dropped rather than sanitised
 * (substituting would show the user something the plugin did not ask for).
 *
 * ITS SCOPE IS AN IDENTIFIER OR A TITLE, never prose (narrowed with S41 item 2, stated here at
 * item 15). Every reader of this constant, measured:
 *
 *   · {@link isDisplayString}'s third clause — `Page.title` / `Panel.title` and
 *     `ComposerRow.id` / `label` / `group` (`seams.tsx`), and `ctx.toast`'s `message` (`ctx.ts`
 *     `invalidToastCall`). A string that fails costs the ENTRY, and the plugin is told once.
 *   · directly, twice in `ctx.ts`: `ctx.toast`'s `detail`, dropped with the rest of the call; and
 *     `ctx.pickFolder`'s `start`, which is only a HINT — an unusable one opens the user's home and
 *     nothing is reported.
 *
 * A `description` is NOT among them. Since item 2 the host does not judge that field at all: it
 * goes through `seams.tsx` `drawnDescription`, which trims and clamps and tests nothing, so a `\n`
 * in a subtitle is drawn rather than costing the panel or the row. The manifest's `name` and
 * `description` are not among them either — they are cleaned by the SDK's own `localizedText`
 * (`plugin-sdk/src/contracts/manifest.ts`), which applies the same idea on the other side of the
 * wire and is a separate implementation.
 */
export const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

/** A display string a host surface may render: non-empty, bounded, no invisible characters. */
export const isDisplayString = (value: unknown, max: number = MAX_LABEL_LENGTH): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= max &&
  !CONTROL_OR_FORMAT.test(value);

/** A slug a plugin may use as a page / panel / row id — it becomes a URL segment or a React key. */
export const PLUGIN_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const isPluginSlug = (value: unknown): value is string =>
  typeof value === "string" && PLUGIN_SLUG_PATTERN.test(value);

/**
 * The seams `ctx.invalidate(seam)` accepts (V2-25).
 *
 * A RUNTIME list as well as a type: the SDK's `./host` entry is types plus three identity helpers
 * and deliberately ships no runtime data (it is inlined into every plugin's server half), and a
 * plugin's `web/index.mjs` is plain JavaScript by the time it reaches the host — the annotation is
 * gone and the argument is whatever the author passed. So the host checks, here, beside every other
 * thing a plugin can get wrong.
 */
export const INVALIDATE_SEAMS: ReadonlyArray<InvalidateSeam> = [
  "composer",
  "panels",
  "pages",
  "background",
];

export const isInvalidateSeam = (value: unknown): value is InvalidateSeam =>
  typeof value === "string" && (INVALIDATE_SEAMS as ReadonlyArray<string>).includes(value);
