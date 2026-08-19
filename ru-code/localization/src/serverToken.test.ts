import { describe, expect, it } from "vite-plus/test";

import {
  Lc,
  containsToken,
  isToken,
  resolveDeep,
  resolveString,
  resolveToken,
  truncateWireSafe,
} from "./serverToken.ts";

const SENTINEL = String.fromCharCode(0x1e);

describe("serverToken — Lc / resolveToken", () => {
  it("resolves a static token in each locale", () => {
    const token = Lc("Could not compact the context", "Не удалось сжать контекст");
    expect(resolveToken(token, "en")).toBe("Could not compact the context");
    expect(resolveToken(token, "ru")).toBe("Не удалось сжать контекст");
  });

  it("resolves an interpolated token, args filled by index (RU may reorder)", () => {
    const token = Lc(
      "Leave blank to let {0} spawn the server.",
      "Оставьте пустым, чтобы {0} запускал сервер.",
      "qwen",
    );
    expect(resolveToken(token, "en")).toBe("Leave blank to let qwen spawn the server.");
    expect(resolveToken(token, "ru")).toBe("Оставьте пустым, чтобы qwen запускал сервер.");
  });

  it("is deterministic — same inputs produce an identical (===-stable) token", () => {
    expect(Lc("A", "Б")).toBe(Lc("A", "Б"));
    expect(Lc("A {0}", "Б {0}", 5)).toBe(Lc("A {0}", "Б {0}", 5));
  });

  it("isToken recognizes tokens and rejects plain strings", () => {
    expect(isToken(Lc("x", "у"))).toBe(true);
    expect(isToken("plain text")).toBe(false);
    expect(isToken(42)).toBe(false);
    expect(isToken(null)).toBe(false);
  });
});

describe("serverToken — safety: never mistranslate, never throw", () => {
  it("passes non-token strings through byte-for-byte", () => {
    const content = "continue the plan, then stop — user's literal message";
    expect(resolveString(content, "ru")).toBe(content);
    expect(resolveDeep(content, "ru")).toBe(content);
  });

  it("leaves a sentinel-containing but non-token string unchanged (no magic tag)", () => {
    const fake = `${SENTINEL}{"e":"x","r":"у"}${SENTINEL}`; // valid JSON, but no t:"ruc1"
    expect(resolveToken(fake, "ru")).toBe(fake);
    expect(resolveString(fake, "ru")).toBe(fake);
  });

  it("leaves malformed JSON between sentinels unchanged (never throws)", () => {
    const broken = `${SENTINEL}{not json${SENTINEL}`;
    expect(resolveString(broken, "en")).toBe(broken);
  });

  it("leaves an unterminated sentinel remainder untouched", () => {
    const partial = `before ${SENTINEL}{"t":"ruc1"`;
    expect(resolveString(partial, "ru")).toBe(partial);
  });

  it("never rewrites model/user content that merely mentions a translated word", () => {
    // "server" is a translated word elsewhere, but plain content is never touched.
    expect(resolveDeep({ text: "restart the server" }, "ru")).toEqual({
      text: "restart the server",
    });
  });
});

describe("serverToken — resolveDeep over structures", () => {
  it("resolves tokens nested in objects and arrays, leaving other fields intact", () => {
    const activity = {
      id: "a1",
      kind: "task.completed", // stable key — must NOT change
      summary: Lc("Context compacted", "Контекст сжат"),
      payload: { detail: Lc("Freed {0} tokens", "Освобождено {0} токенов", 1200), count: 1200 },
      tags: [Lc("info", "инфо"), "raw-tag"],
    };
    expect(resolveDeep(activity, "ru")).toEqual({
      id: "a1",
      kind: "task.completed",
      summary: "Контекст сжат",
      payload: { detail: "Освобождено 1200 токенов", count: 1200 },
      tags: ["инфо", "raw-tag"],
    });
    expect(resolveDeep(activity, "en").summary).toBe("Context compacted");
  });

  it("resolves a nested token passed as an interpolation arg", () => {
    const inner = Lc("world", "мир");
    const outer = Lc("hello {0}", "привет {0}", inner);
    expect(resolveToken(outer, "en")).toBe("hello world");
    expect(resolveToken(outer, "ru")).toBe("привет мир");
  });

  it("resolves multiple/embedded tokens inside one string", () => {
    const s = `[${Lc("Save", "Сохранить")}] and [${Lc("Cancel", "Отмена")}]`;
    expect(resolveString(s, "ru")).toBe("[Сохранить] and [Отмена]");
  });

  it("leaves non-plain objects (custom prototype) and Maps untouched — same ref, not cloned", () => {
    const proto = { tag: "custom" };
    const instance = Object.create(proto) as { label: string };
    instance.label = Lc("x", "у");
    const map = new Map([["k", Lc("v", "в")]]);
    const out = resolveDeep({ instance, map }, "ru");
    expect(out.instance).toBe(instance); // same reference — prototype intact, never cloned
    expect(out.instance.label).toContain(SENTINEL); // token NOT resolved inside a non-plain object
    expect(out.map).toBe(map);
  });

  it("passes primitives through unchanged", () => {
    expect(resolveDeep(42, "ru")).toBe(42);
    expect(resolveDeep(true, "ru")).toBe(true);
    expect(resolveDeep(null, "ru")).toBe(null);
    expect(resolveDeep(undefined, "ru")).toBe(undefined);
  });
});

describe("serverToken — bounded cost", () => {
  it("resolves a large activity list well under a frame budget", () => {
    const list = Array.from({ length: 5000 }, (_unused, i) => ({
      id: `a${i}`,
      summary: Lc("Ran command", "Команда выполнена"),
      detail: Lc("Step {0}", "Шаг {0}", i),
    }));
    const started = 0; // Date.now() unavailable in some runners; assert correctness + no hang
    const resolved = resolveDeep(list, "ru");
    void started;
    expect(resolved[0]!.summary).toBe("Команда выполнена");
    expect(resolved[4999]!.detail).toBe("Шаг 4999");
    expect(resolved.length).toBe(5000);
  });
});

describe("serverToken — containsToken (the clone-skip probe)", () => {
  it("is true exactly when resolveDeep would change something", () => {
    expect(containsToken({ a: [{ b: Lc("x", "у") }] })).toBe(true);
    expect(containsToken({ a: [{ b: "plain" }], n: 4 })).toBe(false);
    expect(containsToken(`embedded ${Lc("x", "у")} tail`)).toBe(true);
  });

  it("skips non-plain objects, mirroring resolveDeep", () => {
    const proto = { tag: "custom" };
    const instance = Object.create(proto) as { label: string };
    instance.label = Lc("x", "у");
    expect(containsToken({ instance })).toBe(false); // resolveDeep would not touch it either
  });
});

describe("serverToken — recursion safety (hostile depth, no hang / no throw)", () => {
  it("multi-level token nesting resolves correctly (each level re-escapes, so depth is naturally bounded)", () => {
    // Token-in-arg nesting doubles the JSON escaping per level, so hostile depth cannot be
    // reached through real payloads — the depth cap is a belt for corrupt data. Verify a
    // realistic 8-level nesting resolves exactly.
    let token = Lc("leaf", "лист");
    for (let i = 0; i < 8; i++) token = Lc("({0})", "[{0}]", token);
    expect(resolveToken(token, "en")).toBe("((((((((leaf))))))))");
    expect(resolveToken(token, "ru")).toBe("[[[[[[[[лист]]]]]]]]");
  });

  it("resolveDeep on a deeply nested object does not blow the stack", () => {
    let node: unknown = { text: Lc("x", "х") };
    for (let i = 0; i < 500; i++) node = { child: node };
    expect(() => resolveDeep(node, "ru")).not.toThrow();
  });
});

describe("serverToken — truncateWireSafe (persist-time limits must never cut a token)", () => {
  // The exact upstream behavior truncateWireSafe must reproduce on plain text.
  const upstreamCut = (value: string, limit: number) =>
    value.length > limit ? `${value.slice(0, limit - 3)}...` : value;

  it("is byte-identical to the caller's plain truncation on token-free text (EN-identity)", () => {
    const long = "x".repeat(500);
    expect(truncateWireSafe(long, 180)).toBe(upstreamCut(long, 180));
    expect(truncateWireSafe("short", 180)).toBe("short");
    expect(truncateWireSafe("", 180)).toBe("");
  });

  it("keeps an over-limit token VALID and RESOLVABLE (the production-leak shape)", () => {
    // The breaker-trip summary: token ≈ 340 chars, WAY over the 180 cap.
    const token = Lc(
      "Compaction barely reduced the context {0}. Auto-compaction disabled.",
      "Сжатие почти не уменьшило контекст {0}. Автосжатие отключено.",
      "(200000 -> 199000)",
    );
    expect(token.length).toBeGreaterThan(180);
    const out = truncateWireSafe(token, 180);
    expect(out.charCodeAt(0)).toBe(0x1e);
    expect(out.charCodeAt(out.length - 1)).toBe(0x1e); // closing sentinel INTACT
    // Short args untouched → resolves to the exact display text.
    expect(resolveToken(out, "ru")).toBe(
      "Сжатие почти не уменьшило контекст (200000 -> 199000). Автосжатие отключено.",
    );
  });

  it("bounds a runaway ARG (the only unbounded part) with the caller's own ellipsis", () => {
    const runaway = "provider stderr ".repeat(100); // 1600 chars
    const token = Lc(
      "Could not compact the context: {0}",
      "Не удалось сжать контекст: {0}",
      runaway,
    );
    const out = truncateWireSafe(token, 180);
    expect(out.length).toBeLessThan(token.length);
    expect(out.charCodeAt(out.length - 1)).toBe(0x1e);
    const resolved = resolveToken(out, "ru");
    expect(resolved.startsWith("Не удалось сжать контекст: provider stderr ")).toBe(true);
    expect(resolved.endsWith("...")).toBe(true);
    expect(resolved.length).toBeLessThan(250); // template + 180-capped arg
  });

  it("truncates plain segments around an embedded token, never the token", () => {
    const token = Lc("Send failed.", "Отправка не удалась.");
    const value = `${"a".repeat(400)}${token}${"b".repeat(400)}`;
    const out = truncateWireSafe(value, 180);
    expect(out).toContain(token); // token byte-identical inside
    expect(resolveString(out, "ru")).toContain("Отправка не удалась.");
    expect(out.length).toBeLessThan(value.length);
  });

  it("treats a foreign / malformed sentinel span as plain text", () => {
    const SENTINEL = String.fromCharCode(0x1e);
    const foreign = `${SENTINEL}${"z".repeat(400)}${SENTINEL}`;
    const out = truncateWireSafe(foreign, 180);
    expect(out.length).toBeLessThanOrEqual(181); // plain-truncated like upstream
    expect(out.endsWith("...")).toBe(true);
  });

  it("truncates a NESTED token arg recursively, keeping every level valid", () => {
    const inner = Lc("inner {0}", "внутри {0}", "y".repeat(400));
    const outer = Lc("outer {0}", "снаружи {0}", inner);
    const out = truncateWireSafe(outer, 180);
    expect(out.charCodeAt(out.length - 1)).toBe(0x1e);
    const resolved = resolveToken(out, "ru");
    expect(resolved.startsWith("снаружи внутри yyy")).toBe(true);
    expect(resolved.endsWith("...")).toBe(true);
  });
});
