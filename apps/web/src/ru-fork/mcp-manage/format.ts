/**
 * Russian-aware count formatting. The app's UI is in Russian, so "1 инструмент" /
 * "2 инструмента" / "5 инструментов" must agree with the number. Kept here so every
 * surface formats counts identically (DRY).
 */

type PluralForms = readonly [one: string, few: string, many: string];

/** Pick the Russian plural form for `count`. */
export function pluralRu(count: number, forms: PluralForms): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

const TOOL_FORMS: PluralForms = ["инструмент", "инструмента", "инструментов"];
const PROJECT_FORMS: PluralForms = ["проект", "проекта", "проектов"];
const PROJECT_PREP_FORMS: PluralForms = ["проекте", "проектах", "проектах"];
const PARAM_FORMS: PluralForms = ["параметр", "параметра", "параметров"];

/** e.g. `4 инструмента`. */
export function toolsCountLabel(count: number): string {
  return `${count} ${pluralRu(count, TOOL_FORMS)}`;
}

/** e.g. `2 проекта`. */
export function projectsCountLabel(count: number): string {
  return `${count} ${pluralRu(count, PROJECT_FORMS)}`;
}

/** e.g. `в 2 проектах` (prepositional case). */
export function inProjectsLabel(count: number): string {
  return `в ${count} ${pluralRu(count, PROJECT_PREP_FORMS)}`;
}

/** e.g. `3 параметра`. */
export function paramsCountLabel(count: number): string {
  return `${count} ${pluralRu(count, PARAM_FORMS)}`;
}
