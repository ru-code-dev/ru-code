/**
 * ru-fork: Analytics — filter dropdown options. Each list is faceted: it's derived
 * from the sessions that already pass the OTHER active filters (time range, sandbox,
 * traffic, the other two dimensions), so every option you can pick returns data. The
 * currently-selected value is always kept present so the control never goes blank.
 *
 * @module ru-fork/stats/model/filterOptions
 */
import type { StatsSession } from "./types";

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export interface RangeOption {
  readonly value: string;
  readonly label: string;
}

export const RANGE_OPTIONS: readonly RangeOption[] = [
  { value: "1", label: "Сегодня" },
  { value: "7", label: "7 дней" },
  { value: "14", label: "14 дней" },
  { value: "30", label: "30 дней" },
  { value: "all", label: "Всё время" },
];

const distinct = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.from(new Set(values.filter((value) => value.length > 0))).toSorted();

export function projectOptions(
  scoped: ReadonlyArray<StatsSession>,
  all: ReadonlyArray<StatsSession>,
  selected: string,
): readonly FilterOption[] {
  const labelById = new Map<string, string>();
  for (const session of scoped) labelById.set(session.projectId, session.projectLabel);
  // Keep the active selection visible even if it has no data in the current window.
  if (selected !== "all" && !labelById.has(selected)) {
    const known = all.find((session) => session.projectId === selected);
    labelById.set(selected, known?.projectLabel ?? selected);
  }
  const entries = Array.from(labelById.entries()).toSorted((first, second) =>
    first[1].localeCompare(second[1]),
  );
  return [
    { value: "all", label: "Все проекты" },
    ...entries.map(([value, label]) => ({ value, label })),
  ];
}

export function modelOptions(
  scoped: ReadonlyArray<StatsSession>,
  selected: string,
): readonly FilterOption[] {
  const models = new Set(distinct(scoped.map((session) => session.model)));
  if (selected !== "all") models.add(selected);
  return [
    { value: "all", label: "Все модели" },
    ...Array.from(models)
      .toSorted()
      .map((model) => ({ value: model, label: model })),
  ];
}

export function branchOptions(
  scoped: ReadonlyArray<StatsSession>,
  selected: string,
): readonly FilterOption[] {
  const branches = new Set(distinct(scoped.map((session) => session.branch)));
  if (selected !== "all") branches.add(selected);
  return [
    { value: "all", label: "Все ветки" },
    ...Array.from(branches)
      .toSorted()
      .map((branch) => ({ value: branch, label: branch })),
  ];
}
