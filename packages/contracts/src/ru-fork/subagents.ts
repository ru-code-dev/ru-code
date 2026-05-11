// ru-fork: filesystem subagent scanner contract.
//
// Surfaces cli-code 0.13.1 built-in agents + ~/<cli-dir>/agents/ +
// <cwd>/<cli-dir>/agents/. `scope` is one of "builtin" | "user" | "project".
// `color` is a CSS color or 'auto'; the web composer paints the chip
// with it. `path` is omitted for built-in agents (no on-disk file).

import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";

export const ServerProviderSubagent = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  path: Schema.optional(TrimmedNonEmptyString),
  scope: TrimmedNonEmptyString,
  color: Schema.optional(TrimmedNonEmptyString),
  tools: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  enabled: Schema.Boolean,
});
export type ServerProviderSubagent = typeof ServerProviderSubagent.Type;
