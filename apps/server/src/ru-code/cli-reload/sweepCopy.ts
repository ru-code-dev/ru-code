// ru-code (cli-reload): the closing copy the RELOAD sweep writes.
//
// The sweep itself is the boot sweep's own `runQwenBootSweepWith` (startup/qwenBootSweep.ts) —
// same single-writer dispatches, same rows, same session-stop shape. Only the wording differs:
// a reload is not a server restart, and telling the user "cancelled by a server restart" when
// they pressed «Перезагрузить CLI» is a lie (research B-G1). The boot constants are left
// untouched; these ride in as a parameter.
//
// Localization: server-emitted display strings in `apps/server/src/**` are dictionary-driven
// (the build transform scopes by repo-relative path — R18), exactly like the boot copy this
// mirrors; the Russian lives in
// ru-code/localization/dict/apps/server/src/ru-code/cli-reload/sweepCopy.ts.json.

import type { QwenSweepTexts } from "../startup/qwenBootSweep.ts";

export const RELOAD_INTERRUPTED_COMPACTION_TEXT = "Compaction interrupted by a CLI reload.";
export const RELOAD_CANCELLED_APPROVAL_TEXT = "Approval request cancelled by a CLI reload.";
export const RELOAD_CANCELLED_USER_INPUT_TEXT = "Question cancelled by a CLI reload.";
export const RELOAD_INTERRUPTED_AGENT_TEXT = "Agent interrupted by a CLI reload.";

export const CLI_RELOAD_SWEEP_TEXTS: QwenSweepTexts = {
  interruptedCompaction: RELOAD_INTERRUPTED_COMPACTION_TEXT,
  cancelledApproval: RELOAD_CANCELLED_APPROVAL_TEXT,
  cancelledUserInput: RELOAD_CANCELLED_USER_INPUT_TEXT,
  interruptedAgent: RELOAD_INTERRUPTED_AGENT_TEXT,
};
