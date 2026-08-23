// ru-code: EN-identity pin for the ChangedFilesTree.tsx bilingual seams (see the
// `// ru-code:` marks around the header count and the "Show all N files" button). Both
// use Lp (bilingual plural seam, Sidebar.tsx:255-262 shape) because English's 2-way
// singular/plural split can't carry Russian's one/few/many noun agreement. This test pins
// the ENGLISH render at n=1/n=3/n=5 exactly as it renders — the Russian side is proven by
// the dict/build gates (localize:check / localize:guard / build), not here. The test
// runner defaults to English locale (locale.ts: VITEST ⇒ "en"), so Lp(...) below exercises
// the same branch the component takes without needing setLocale.
import { Lp } from "@ru-code/localization";
import { describe, expect, it } from "vite-plus/test";

// Mirrors ChangedFilesTree.tsx's header count seam exactly (same Lp arguments, same shape).
function changedFilesCountFor(count: number): string {
  return `${count} ${Lp(
    count,
    ["changed file", "changed files"],
    ["изменённый файл", "изменённых файла", "изменённых файлов"],
  )}`;
}

// Mirrors ChangedFilesTree.tsx's "Show all N files" seam exactly. n>1 stays byte-identical
// to the pre-port literal ("Show all {n} files"); n=1 is corrected to singular "file" —
// deliberate, owner-approved (DISPATCH 2).
function showAllFilesFor(count: number): string {
  return Lp(
    count,
    [`Show all ${count} file`, `Show all ${count} files`],
    [`Показать весь ${count} файл`, `Показать все ${count} файла`, `Показать все ${count} файлов`],
  );
}

describe("ChangedFilesTree bilingual seams — EN identity", () => {
  it("`N changed file(s)` header — n=1/n>1 matches today's exact English", () => {
    expect(changedFilesCountFor(1)).toBe("1 changed file");
    expect(changedFilesCountFor(2)).toBe("2 changed files");
  });

  it("`N changed file(s)` header — pinned at n=1/n=3/n=5", () => {
    expect(changedFilesCountFor(1)).toBe("1 changed file");
    expect(changedFilesCountFor(3)).toBe("3 changed files");
    expect(changedFilesCountFor(5)).toBe("5 changed files");
  });

  it("`Show all N files` — n>1 stays byte-identical to today", () => {
    expect(showAllFilesFor(2)).toBe("Show all 2 files");
  });

  it("`Show all N files` — pinned at n=1/n=3/n=5 (n=1 corrected to singular)", () => {
    expect(showAllFilesFor(1)).toBe("Show all 1 file");
    expect(showAllFilesFor(3)).toBe("Show all 3 files");
    expect(showAllFilesFor(5)).toBe("Show all 5 files");
  });
});
