// ru-code: SW page kit — shared stylesheet for the service-worker-served pages.
// PURE CSS string: no React, no imports from the app bundle. Colors reference the
// app's theme tokens (var(--background) …) with neutral fallbacks, so:
//   · previewed inside the app → inherits the active palette (all 8 themes × light/dark)
//   · served standalone by the SW → falls back to the neutral dark look, or picks the
//     tokens up from the precached theme CSS once the build plugin links it.
// Class names are prefixed `rcu-` (a private namespace for these pages) to avoid
// collisions in preview.

// #31 — the standalone document reset lives in parts.ts (co-located with the
// pageDocument that prepends it), so this pure-CSS leaf imports nothing.

export const SW_PAGE_CSS = /* css */ `
.rcu-wrap, .rcu-wrap * { box-sizing: border-box; margin: 0; }
.rcu-wrap {
  min-height: 100dvh;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 22px; padding: 48px 20px;
  background:
    radial-gradient(720px 420px at 50% -6%, color-mix(in srgb, var(--primary, #4a72ff) 7%, transparent), transparent 62%),
    var(--background, #131316);
  color: var(--foreground, #ececf0);
  font-family: var(--font-sans, ui-sans-serif, -apple-system, "Segoe UI", Roboto, Arial, sans-serif);
  font-size: 14px; line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-align: center;
}
.rcu-mono { font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace; }

/* brand */
.rcu-brand { display: flex; align-items: center; gap: 11px; text-align: left; }
.rcu-mark {
  width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center;
  background: var(--primary, #4a72ff); color: var(--primary-foreground, #fff);
  font: 700 15px/1 ui-monospace, Menlo, monospace;
  box-shadow: 0 6px 22px color-mix(in srgb, var(--primary, #4a72ff) 26%, transparent);
}
.rcu-brand-name { font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
.rcu-brand-sub { font-size: 11px; color: var(--muted-foreground, #9a9aa6); margin-top: 2px; }

/* emblem */
.rcu-emblem { position: relative; width: 88px; height: 88px; display: grid; place-items: center; }
.rcu-ring, .rcu-arc { position: absolute; inset: 0; border-radius: 50%; border: 2px solid var(--border, #2c2c34); }
.rcu-arc { border-color: transparent; border-top-color: var(--primary, #4a72ff); animation: rcu-spin 1s linear infinite; }
.rcu-glyph { width: 36px; height: 36px; color: var(--primary, #4a72ff); }
.rcu-emblem[data-tone="ok"] .rcu-glyph { color: var(--success-foreground, #57c98a); }
.rcu-emblem[data-tone="ok"] .rcu-arc { display: none; }
.rcu-emblem[data-tone="ok"] .rcu-ring { border-color: color-mix(in srgb, var(--success, #2f9e63) 55%, var(--border, #2c2c34)); }
.rcu-emblem[data-tone="err"] .rcu-glyph { color: var(--destructive-foreground, #f26d6d); }
.rcu-emblem[data-tone="err"] .rcu-arc { display: none; }
.rcu-emblem[data-tone="err"] .rcu-ring { border-color: color-mix(in srgb, var(--destructive, #cc3b3b) 55%, var(--border, #2c2c34)); }
@keyframes rcu-spin { to { transform: rotate(360deg); } }

.rcu-headline { font-size: 23px; font-weight: 650; letter-spacing: -0.01em; text-wrap: balance; }
.rcu-subline { max-width: 46ch; color: var(--muted-foreground, #9a9aa6); font-size: 14px; margin-top: 7px; }
.rcu-subline b { color: var(--foreground, #ececf0); font-weight: 600; }

/* progress track (updating) */
.rcu-track { width: min(430px, 100%); display: flex; flex-direction: column; gap: 12px; }
.rcu-bar {
  height: 7px; border-radius: 99px; overflow: hidden;
  background: var(--muted, #222228); border: 1px solid var(--border, #2c2c34);
}
.rcu-bar i {
  display: block; height: 100%; border-radius: 99px; background: var(--primary, #4a72ff);
  transition: width 0.35s ease;
}
.rcu-flow { display: flex; justify-content: space-between; gap: 6px; }
.rcu-step {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px;
  font: 600 10px/1.2 ui-monospace, Menlo, monospace; letter-spacing: 0.05em; text-transform: uppercase;
  color: color-mix(in srgb, var(--muted-foreground, #9a9aa6) 72%, transparent);
}
.rcu-step .rcu-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--border, #3a3a44); }
.rcu-step[data-state="done"] { color: var(--success-foreground, #57c98a); }
.rcu-step[data-state="done"] .rcu-dot { background: var(--success-foreground, #57c98a); }
.rcu-step[data-state="now"] { color: var(--primary, #4a72ff); }
.rcu-step[data-state="now"] .rcu-dot {
  background: var(--primary, #4a72ff);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--primary, #4a72ff) 18%, transparent);
}

/* cards */
.rcu-card {
  width: min(460px, 100%); text-align: left; overflow: hidden;
  background: var(--card, #1b1b1f); color: var(--card-foreground, var(--foreground, #ececf0));
  border: 1px solid var(--border, #2c2c34); border-radius: 14px;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.14), 0 10px 30px rgb(0 0 0 / 0.12);
}
.rcu-card-head { display: flex; align-items: center; gap: 9px; padding: 12px 15px; border-bottom: 1px solid var(--border, #2c2c34); font-weight: 600; font-size: 13px; }
.rcu-card-head .rcu-kicker { margin-left: auto; font: 600 9.5px/1 ui-monospace, Menlo, monospace; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted-foreground, #9a9aa6); }
.rcu-cmd { display: flex; align-items: center; gap: 10px; padding: 12px 15px; background: var(--muted, #222228); }
.rcu-cmd .rcu-prompt { color: var(--success-foreground, #57c98a); font-weight: 700; }
.rcu-cmd code { flex: 1; font-size: 13px; }
.rcu-cmd button {
  border: 1px solid var(--input, #3a3a44); background: var(--card, #1b1b1f); color: var(--muted-foreground, #9a9aa6);
  border-radius: 8px; padding: 5px 10px; font: 600 11px/1 inherit; cursor: pointer; font-family: inherit;
}
.rcu-cmd button:hover { color: var(--foreground, #ececf0); border-color: var(--primary, #4a72ff); }
.rcu-card-alt { padding: 10px 15px; font-size: 12px; color: var(--muted-foreground, #9a9aa6); border-top: 1px solid var(--border, #2c2c34); }
.rcu-card-alt code { color: var(--foreground, #ececf0); }

/* facts grid */
.rcu-facts {
  width: min(460px, 100%); display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
  background: var(--border, #2c2c34); border: 1px solid var(--border, #2c2c34);
  border-radius: 14px; overflow: hidden; text-align: left;
}
.rcu-fact { background: var(--card, #1b1b1f); padding: 11px 14px; }
.rcu-fact .rcu-k { font: 600 9.5px/1 ui-monospace, Menlo, monospace; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted-foreground, #9a9aa6); }
.rcu-fact .rcu-v { margin-top: 5px; font-size: 12.5px; font-weight: 600; overflow-wrap: anywhere; word-break: break-word; }
.rcu-fact .rcu-v[data-dim] { color: var(--muted-foreground, #9a9aa6); font-weight: 500; }
.rcu-ok-dot { color: var(--success-foreground, #57c98a); }
.rcu-err-dot { color: var(--destructive-foreground, #f26d6d); }

/* actions */
.rcu-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
.rcu-btn {
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
  border: 1px solid var(--input, #3a3a44); background: var(--card, #1b1b1f); color: var(--foreground, #ececf0);
  padding: 9px 16px; border-radius: 10px; font: 600 13.5px/1.2 inherit; font-family: inherit;
}
.rcu-btn:hover { border-color: var(--primary, #4a72ff); }
.rcu-btn[data-variant="primary"] { background: var(--primary, #4a72ff); color: var(--primary-foreground, #fff); border-color: transparent; }
.rcu-btn[data-variant="primary"]:hover { filter: brightness(1.07); }
.rcu-btn[data-variant="ghost"] { background: transparent; border-color: transparent; color: var(--muted-foreground, #9a9aa6); }
.rcu-btn[data-variant="ghost"]:hover { color: var(--foreground, #ececf0); }

/* error panel */
.rcu-error {
  width: min(460px, 100%); text-align: left; border-radius: 14px; padding: 13px 15px;
  border: 1px solid color-mix(in srgb, var(--destructive, #cc3b3b) 32%, transparent);
  background: color-mix(in srgb, var(--destructive, #cc3b3b) 7%, var(--card, #1b1b1f));
}
.rcu-error b { display: block; font-size: 13.5px; }
.rcu-error p { margin-top: 4px; font-size: 12.5px; color: var(--muted-foreground, #9a9aa6); }

/* dev details */
.rcu-dev { width: min(460px, 100%); text-align: left; }
.rcu-dev summary {
  cursor: pointer; list-style: none; display: flex; justify-content: center; align-items: center; gap: 7px;
  padding: 6px; color: var(--muted-foreground, #9a9aa6); font-weight: 600; font-size: 12.5px;
}
.rcu-dev summary::-webkit-details-marker { display: none; }
.rcu-dev summary .rcu-tw { transition: transform 0.15s; display: inline-block; }
.rcu-dev[open] summary .rcu-tw { transform: rotate(90deg); }
.rcu-log {
  margin-top: 10px; padding: 11px 13px; max-height: 170px; overflow: auto; text-align: left;
  background: var(--muted, #202026); border: 1px solid var(--border, #2c2c34); border-radius: 12px;
  font: 400 11.5px/1.75 ui-monospace, Menlo, monospace; color: var(--muted-foreground, #9a9aa6);
}
.rcu-log .rcu-t { color: color-mix(in srgb, var(--muted-foreground, #9a9aa6) 55%, transparent); margin-right: 8px; }
.rcu-log [data-tone="ok"]  { color: var(--success-foreground, #57c98a); }
.rcu-log [data-tone="act"] { color: var(--primary, #4a72ff); }
.rcu-log [data-tone="warn"]{ color: var(--warning-foreground, #f2b750); }
.rcu-log [data-tone="err"] { color: var(--destructive-foreground, #f26d6d); }
.rcu-kv { margin-top: 10px; display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 12px; }
.rcu-kv dt { color: var(--muted-foreground, #9a9aa6); }
.rcu-kv dd { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; word-break: break-all; }

.rcu-foot { display: flex; align-items: center; gap: 7px; color: color-mix(in srgb, var(--muted-foreground, #9a9aa6) 80%, transparent); font-size: 12px; }
.rcu-back { font-size: 12.5px; color: var(--muted-foreground, #9a9aa6); text-decoration: none; }
.rcu-back:hover { color: var(--foreground, #ececf0); text-decoration: underline; }

@media (prefers-reduced-motion: reduce) {
  .rcu-arc { animation: none; }
  .rcu-bar i { transition: none; }
}
`;
