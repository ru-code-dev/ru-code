import { afterEach, describe, expect, it } from "vite-plus/test";
import { getLocale, L, Lp, LT, pluralRu, setLocale } from "./index.ts";

// The module locale is a process-level singleton; reset after each test.
afterEach(() => setLocale("ru"));

describe("pluralRu (CLDR one/few/many)", () => {
  const forms = ["файл", "файла", "файлов"] as const;
  it("selects the correct form across the boundary cases", () => {
    expect(pluralRu(1, forms)).toBe("файл");
    expect(pluralRu(2, forms)).toBe("файла");
    expect(pluralRu(5, forms)).toBe("файлов");
    expect(pluralRu(11, forms)).toBe("файлов");
    expect(pluralRu(21, forms)).toBe("файл");
    expect(pluralRu(22, forms)).toBe("файла");
    expect(pluralRu(111, forms)).toBe("файлов");
    expect(pluralRu(121, forms)).toBe("файл");
  });
});

describe("L — plain display string", () => {
  it("is the identity of its English argument in English locale", () => {
    setLocale("en");
    expect(L("Save", "Сохранить")).toBe("Save");
    // This is the transform-safety property: L(en, ru) === en ⇒ transformed program
    // behaves exactly like the original English source.
  });
  it("returns Russian in Russian locale", () => {
    setLocale("ru");
    expect(L("Save", "Сохранить")).toBe("Сохранить");
  });
});

describe("LT — interpolated display string", () => {
  it("reconstructs the original template in English locale", () => {
    setLocale("en");
    expect(LT("Found {0} files", "Найдено {0} файлов", [3])).toBe("Found 3 files");
  });
  it("fills the Russian skeleton in Russian locale", () => {
    setLocale("ru");
    expect(LT("Found {0} files", "Найдено {0} файлов", [3])).toBe("Найдено 3 файлов");
  });
  it("supports reordered placeholders", () => {
    setLocale("ru");
    expect(LT("{0} of {1}", "{1} из {0}", ["a", "b"])).toBe("b из a");
  });
});

describe("Lp — locale-aware plural", () => {
  const en = ["file", "files"] as const;
  const ru = ["файл", "файла", "файлов"] as const;
  it("uses English singular/plural in English locale", () => {
    setLocale("en");
    expect(Lp(1, en, ru)).toBe("file");
    expect(Lp(3, en, ru)).toBe("files");
  });
  it("uses the Russian plural rule in Russian locale", () => {
    setLocale("ru");
    expect(Lp(1, en, ru)).toBe("файл");
    expect(Lp(3, en, ru)).toBe("файла");
    expect(Lp(5, en, ru)).toBe("файлов");
  });
});

describe("default locale", () => {
  it("is Russian (fresh install ships localized)", () => {
    // getLocale reflects the afterEach reset; the shipped default is "ru".
    expect(getLocale()).toBe("ru");
  });
});
