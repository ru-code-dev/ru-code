// ru-code: SW page kit — tiny pure-HTML emitters shared by both pages.
// Plain template functions returning strings: no React, no DOM, no app imports
// beyond @ru-code/branding (worker-safe constants, bundled by swBuildPlugin).
// Interactive elements carry `data-action="…"` — the preview bridge (and later
// the page's own vanilla script) handles them via event delegation.

import { APP_NAME } from "@ru-code/branding";

import type { SwLocale } from "./strings";

/**
 * #31 — the standalone document reset. Prepended to the SW-served document's
 * `<style>` ONLY (never into `SW_PAGE_CSS`, so the in-app preview fragments stay
 * pixel-identical). Without it the UA `body{margin:8px}` + the page's own
 * `min-height:100dvh` produce white bands and a permanent scrollbar on the
 * standalone pages. Lives here — beside {@link pageDocument} — so the pure-CSS
 * `theme.ts` stays an import-free leaf.
 */
export const STANDALONE_RESET = `html,body{margin:0;padding:0;min-height:100dvh;background:var(--background,#131316)}`;

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function brand(sub: string): string {
  // #34 — the product name comes from branding; keep it on one line (nbsp).
  const name = esc(APP_NAME).replace(/ /g, "&nbsp;");
  return `
<div class="rcu-brand">
  <div class="rcu-mark">&gt;_</div>
  <div>
    <div class="rcu-brand-name">${name}</div>
    <div class="rcu-brand-sub rcu-mono">${esc(sub)}</div>
  </div>
</div>`;
}

/**
 * The «run this command» card shared by the down page and the updating page's
 * manual screen. The command literal comes from branding (#34); the copy button
 * carries a `copy-label` slot so the page script can flash «Скопировано» and
 * revert (#37). All copy is pre-localized by the caller.
 */
export function commandCard(input: {
  head: string;
  kicker: string;
  command: string;
  altHtml: string;
  copyLabel: string;
}): string {
  return `
<div class="rcu-card">
  <div class="rcu-card-head">${esc(input.head)} <span class="rcu-kicker">${esc(input.kicker)}</span></div>
  <div class="rcu-cmd rcu-mono">
    <span class="rcu-prompt">$</span>
    <code>${esc(input.command)}</code>
    <button type="button" data-action="copy-cmd" data-rcu="copy-label">${esc(input.copyLabel)}</button>
  </div>
  <div class="rcu-card-alt">${input.altHtml}</div>
</div>`;
}

const GLYPHS = {
  up: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m0 0-6 6m6-6 6 6"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  plug: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v6m6-6v6M7 9h10v3a5 5 0 0 1-10 0V9zM12 17v4"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg>`,
} as const;

export type EmblemGlyph = keyof typeof GLYPHS;

export function emblem(glyph: EmblemGlyph, tone: "spin" | "ok" | "err"): string {
  return `
<div class="rcu-emblem" data-tone="${tone}">
  <div class="rcu-ring"></div>
  <div class="rcu-arc"></div>
  <div class="rcu-glyph">${GLYPHS[glyph]}</div>
</div>`;
}

export interface FactVm {
  label: string;
  /** already-safe HTML (may contain the status dot span) */
  valueHtml: string;
  dim?: boolean;
}

export function factsGrid(facts: FactVm[]): string {
  return `
<div class="rcu-facts">
  ${facts
    .map(
      (fact) => `
  <div class="rcu-fact">
    <div class="rcu-k">${esc(fact.label)}</div>
    <div class="rcu-v rcu-mono"${fact.dim ? " data-dim" : ""}>${fact.valueHtml}</div>
  </div>`,
    )
    .join("")}
</div>`;
}

export interface LogLineVm {
  time?: string;
  tone: "dim" | "ok" | "act" | "warn" | "err";
  text: string;
}

export function logBox(lines: LogLineVm[]): string {
  return `
<div class="rcu-log">
  ${lines
    .map(
      (line) =>
        `<div>${line.time ? `<span class="rcu-t">${esc(line.time)}</span>` : ""}<span data-tone="${line.tone}">${esc(line.text)}</span></div>`,
    )
    .join("")}
</div>`;
}

export function devDetails(label: string, innerHtml: string): string {
  return `
<details class="rcu-dev">
  <summary><span class="rcu-tw">▸</span> ${esc(label)}</summary>
  ${innerHtml}
</details>`;
}

export function keyValue(entries: Array<[string, string]>): string {
  return `
<dl class="rcu-kv">
  ${entries.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join("")}
</dl>`;
}

export function button(
  label: string,
  options: { action: string; variant?: "primary" | "ghost"; slot?: string } = { action: "" },
): string {
  const variant = options.variant ? ` data-variant="${options.variant}"` : "";
  // `slot` names the label for the page runtime script (data-rcu text slots).
  const slot = options.slot ? ` data-rcu="${esc(options.slot)}"` : "";
  return `<button class="rcu-btn" type="button" data-action="${esc(options.action)}"${variant}${slot}>${esc(label)}</button>`;
}

/** Wrap a page fragment into a complete standalone HTML document (what the SW serves).
 *  `extras.headHtml` carries the SW's mirrored theme `<style>` tag; `extras.script`
 *  carries the vanilla page runtime (data-action delegation + healthz polling);
 *  `extras.lang` sets the document language (default ru — #35). The standalone
 *  reset is prepended to the `<style>` here ONLY, so preview fragments (which use
 *  {@link SW_PAGE_CSS} directly) stay pixel-identical (#31). */
export function pageDocument(
  title: string,
  css: string,
  bodyHtml: string,
  extras: { headHtml?: string; script?: string; lang?: SwLocale } = {},
): string {
  const script = extras.script !== undefined ? `<script>${extras.script}</script>` : "";
  const lang = extras.lang ?? "ru";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STANDALONE_RESET}${css}</style>
${extras.headHtml ?? ""}
</head>
<body>${bodyHtml}${script}</body>
</html>`;
}
