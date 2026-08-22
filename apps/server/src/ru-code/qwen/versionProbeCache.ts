// ru-code: remembers what `node <cliJs> --version` reported, for the lifetime of the server
// process, keyed by the CLI path the probe ran against.
//
// The probe is a real child process. Without a cache it runs on every snapshot refresh — the
// driver's 5-minute loop, every client reconnect (the `subscribeServerConfig` first frame
// forks a provider refresh) and every settings save — which on a slow machine means a steady
// stream of CLI cold starts that each take tens of seconds.
//
// The version cannot change under a running server unless the configured path changes, and the
// path IS the key: a different `binaryPath` is a different entry and probes on its own. The key
// is an opaque string — no normalisation, no platform rules. Two spellings of the same file
// simply probe twice, which costs one extra probe and can never produce a wrong answer, since
// every entry is the verdict its own path produced.
//
// What is cached:
//   • a completed probe — the CLI answered (with or without a parseable version);
//   • a timed-out probe — a legitimate "installed, version unknown" verdict. This one matters
//     most: the machines that time out are exactly the slow ones, and NOT caching them would
//     leave those machines re-probing forever.
// What is not cached:
//   • a failed spawn (missing/moved cli.js) — installing or fixing the CLI must be picked up by
//     the next refresh rather than being remembered as broken for the whole session.

import type { QwenVersionResult } from "./QwenProvider.ts";

const versionProbeByCliPath = new Map<string, QwenVersionResult>();

/** The remembered verdict for `cliJs`, or `undefined` when that path has not been probed yet. */
export function getCachedVersionProbe(cliJs: string): QwenVersionResult | undefined {
  return versionProbeByCliPath.get(cliJs);
}

/** Remember `result` as the verdict for `cliJs`. */
export function setCachedVersionProbe(cliJs: string, result: QwenVersionResult): void {
  versionProbeByCliPath.set(cliJs, result);
}

/** Drop every remembered verdict. Tests only — the process cache has no production reset. */
export function clearVersionProbeCacheForTests(): void {
  versionProbeByCliPath.clear();
}
