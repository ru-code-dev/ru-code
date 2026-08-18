/**
 * Picks the correct Russian plural form for `count`.
 * `forms` = [one, few, many], e.g. ["элемент", "элемента", "элементов"]
 * → 1 элемент, 2 элемента, 5 элементов, 11 элементов, 21 элемент.
 */
export function pluralRu(count: number, forms: readonly [string, string, string]): string {
  const abs = Math.abs(count) % 100;
  const ones = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (ones > 1 && ones < 5) return forms[1];
  if (ones === 1) return forms[0];
  return forms[2];
}
