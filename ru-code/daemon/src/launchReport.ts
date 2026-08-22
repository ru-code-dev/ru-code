// ru-code: the machine-readable launch contract (`--json`). The installer runs the
// launcher, captures ONE stdout line and reads `ok` (and `url` on success) — it never
// parses `error`, whose text is for a human reading the log. Both success branches
// (ready + already-running) and every failure exit go through these two builders, so
// the shapes cannot drift apart. JSON.stringify only: quotes, newlines and backslashes
// in a url or a message are escaped by construction, never by hand.

/** `{"ok":true,"url":…,"version":…,"pid":…}` — one line, no trailing newline. */
export const formatLaunchSuccessJson = (params: {
  readonly url: string;
  readonly version: string;
  readonly pid: number;
}): string =>
  JSON.stringify({ ok: true, url: params.url, version: params.version, pid: params.pid });

/** `{"ok":false,"error":…,"log":…}` — `error` carries the localized human message. */
export const formatLaunchFailureJson = (params: {
  readonly error: string;
  readonly log: string;
}): string => JSON.stringify({ ok: false, error: params.error, log: params.log });
