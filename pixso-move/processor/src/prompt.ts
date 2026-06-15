export interface PromptInput {
  readonly prompt: string;
  readonly rootName: string;
  readonly nodesJson: string;
}

// Deterministic prompt builder: the configured instruction, an output rule, then the
// payload (component name + fenced node JSON). Pure — no I/O, no clock, no randomness.
export const buildPrompt = (input: PromptInput): string =>
  [
    input.prompt.trim(),
    "",
    "Верни только результат, без пояснений.",
    "",
    `Компонент: ${input.rootName}`,
    "",
    "```json",
    input.nodesJson,
    "```",
  ].join("\n");
