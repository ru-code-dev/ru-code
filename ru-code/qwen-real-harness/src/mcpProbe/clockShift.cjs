// ru-code (S94 probe): a wall-clock SHIFT for the app server process only — the stand-in for
// "31 minutes passed" in the session/load-after-TTL case.
//
// Loaded with `NODE_OPTIONS=--require <this file>`; every child the server spawns inherits the
// option, so it acts ONLY when the main module is the server bundle (`…/bin.mjs`): the CLI proxy,
// qwen and the fake MCP servers keep the real clock. It offsets `Date.now()` by the number of
// milliseconds written in `PROBE_CLOCK_OFFSET_FILE` (re-read at most every 200 ms of real time),
// which is what effect's `Clock.currentTimeMillisUnsafe` returns (effect internal/effect.js:2656)
// and therefore what the app's spawn-record Cache TTL is measured against (effect Cache.js:308).
// Timers (setTimeout / Effect.sleep) are untouched. With no file, or 0 in it, nothing changes.

"use strict";

const NodeFS = require("node:fs");

const offsetFile = process.env["PROBE_CLOCK_OFFSET_FILE"];
const isServer = typeof process.argv[1] === "string" && process.argv[1].endsWith("bin.mjs");

if (offsetFile && isServer) {
  const realNow = Date.now.bind(Date);
  let offsetMs = 0;
  let readAt = -Infinity;
  Date.now = () => {
    const real = realNow();
    if (real - readAt > 200) {
      readAt = real;
      try {
        offsetMs = Number(NodeFS.readFileSync(offsetFile, "utf8").trim()) || 0;
      } catch {
        offsetMs = 0;
      }
    }
    return real + offsetMs;
  };
}
