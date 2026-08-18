// Fill `{key}` placeholders in a template from a values map. Unknown keys are
// left verbatim so a missing value is visible rather than silently dropped.

export const render = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? `{${k}}`);
