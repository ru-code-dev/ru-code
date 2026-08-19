// ru-code: @ru-code/qwen public barrel.
//
// This package holds the provider-agnostic, self-contained pieces of the qwen
// integration — the error type model + dispatcher + request-log formatter, ACP
// spawn helpers, and small runtime utilities. The pieces that bind to the t3
// server provider SPI (QwenAdapter/Driver/Provider, the recognizer table, the
// ACP session runtime, text-generation) stay in `apps/server/src/ru-code/qwen`,
// as does the boot CLI detection (apps/server/src/ru-code/startup, which reuses
// the single install-time preflight resolver).
//
// Most consumers import specific subpaths (e.g. `@ru-code/qwen/errors/dispatch`);
// this barrel re-exports the cross-cutting error type model that both the
// app-side table and the dispatcher share.

export type { CliErrorDecision } from "./errors/types.ts";
export { Surface, hasSurface, surfaceLabel } from "./errors/types.ts";
