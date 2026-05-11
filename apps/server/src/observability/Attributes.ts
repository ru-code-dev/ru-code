/**
 * Attributes — no-op trace attribute helpers.
 *
 * Telemetry was removed. The helpers below are identity passthroughs kept
 * only so existing call sites continue to compile.
 */
type Attributes = Readonly<Record<string, unknown>>;

export const compactTraceAttributes = (input: Attributes): Attributes => input;
