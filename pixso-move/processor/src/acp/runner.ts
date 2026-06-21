import * as Context from "effect/Context";

import type { AcpRunnerShape } from "../types.ts";

// The ACP runner service tag. Production provides `AcpRunnerLive` (real qwen spawn, see
// acpRunnerLive.integration.ts); tests provide a scripted fake. The embed layer resolves
// this and hands it to the engine as `deps.acp`.
export class AcpRunner extends Context.Service<AcpRunner, AcpRunnerShape>()(
  "@pixso-move/processor/acp/runner/AcpRunner",
) {}
