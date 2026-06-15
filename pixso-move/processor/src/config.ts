import { DesignerId, ResultTag } from "@pixso-move/contracts";

import type { ProcessorConfig } from "./types.ts";

// The operator-edited processing config. Only the designer id, the prompt, and the result
// tag are hardcoded; the CLI path / home / auth method are resolved from the server config
// and environment (never hardcoded). Add an entry per designer you want enriched.
export const processorConfig: ProcessorConfig = [
  {
    designerId: DesignerId.make("dz_c07a93f7-2505-4e60-94af-17a2cc068b79"),
    resultTag: ResultTag.make("html-css"),
    prompt:
      "Создай html/css all in single file for this component. " +
      "Используй только один файл, без внешних зависимостей.",
  },
];
