// ru-code: the WS RPC egress-localization parser — the LAST server hop every socket byte
// passes. Wire tokens (Lc) anywhere in an outgoing message must leave as display text in
// the server's current locale; everything else must leave byte-identical. These tests run
// the REAL production parser (`localizedJsonSerialization`, the exact service ws.ts
// installs), not a lookalike.
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Lc, setLocale } from "@ru-code/localization";

import { localizedJsonSerialization } from "../../localization/wireEgress.ts";

const parser = () => localizedJsonSerialization.makeUnsafe();

// The vitest default locale is EN; every test that switches must restore it.
afterEach(() => setLocale("en"));

const ADVICE = Lc(
  "Compacting an already-compacted or short conversation is ineffective — the CLI needs new messages for compaction to help.",
  "Сжимать уже сжатый или короткий диалог неэффективно — CLI нужны новые сообщения, чтобы сжатие дало результат.",
);

describe("egress encode — tokens resolve in the server locale", () => {
  it("resolves a token nested deep in an activity payload (the compaction-advice shape)", () => {
    const message = {
      _tag: "Exit",
      value: {
        thread: {
          activities: [
            { kind: "task.completed", payload: { detail: ADVICE, usage: { preTokens: 200_000 } } },
          ],
        },
      },
    };
    setLocale("ru");
    const encodedRu = String(parser().encode(message));
    expect(encodedRu).not.toContain("\\u001e");
    const decodedRu = JSON.parse(encodedRu) as typeof message;
    expect(decodedRu.value.thread.activities[0]!.payload.detail).toBe(
      "Сжимать уже сжатый или короткий диалог неэффективно — CLI нужны новые сообщения, чтобы сжатие дало результат.",
    );
    // The non-display data around the token is untouched.
    expect(decodedRu.value.thread.activities[0]!.payload.usage).toEqual({ preTokens: 200_000 });

    setLocale("en");
    const decodedEn = JSON.parse(String(parser().encode(message))) as typeof message;
    expect(decodedEn.value.thread.activities[0]!.payload.detail).toBe(
      "Compacting an already-compacted or short conversation is ineffective — the CLI needs new messages for compaction to help.",
    );
  });

  it("resolves an INTERPOLATED token — the args ride the token and fill per-locale", () => {
    const message = {
      summary: Lc(
        "Compaction succeeded {0}.",
        "Сжатие выполнено успешно {0}.",
        "(200000 -> 12345)",
      ),
    };
    setLocale("ru");
    expect(JSON.parse(String(parser().encode(message))).summary).toBe(
      "Сжатие выполнено успешно (200000 -> 12345).",
    );
    setLocale("en");
    expect(JSON.parse(String(parser().encode(message))).summary).toBe(
      "Compaction succeeded (200000 -> 12345).",
    );
  });

  it("resolves a token EMBEDDED mid-string (the assistant-bubble `\\n\\n${text}` case)", () => {
    const bubble = {
      _tag: "Chunk",
      text: `already streamed\n\n${Lc("Send failed.", "Отправка не удалась.")}`,
    };
    setLocale("ru");
    const decoded = JSON.parse(String(parser().encode(bubble))) as typeof bubble;
    expect(decoded.text).toBe("already streamed\n\nОтправка не удалась.");
  });

  it("resolves a token in shell fields (session.lastError / title sinks)", () => {
    const shell = {
      threads: [{ title: "user's own title", session: { lastError: Lc("Busy.", "Занято.") } }],
    };
    setLocale("ru");
    const decoded = JSON.parse(String(parser().encode(shell))) as typeof shell;
    expect(decoded.threads[0]!.session.lastError).toBe("Занято.");
    expect(decoded.threads[0]!.title).toBe("user's own title");
  });
});

describe("egress encode — everything token-free leaves byte-identical", () => {
  it("a token-free message is the plain JSON.stringify output (fast path, same bytes)", () => {
    const message = { _tag: "Exit", value: { rows: [1, 2, 3], text: "plain user text" } };
    expect(parser().encode(message)).toBe(JSON.stringify(message));
  });

  it("a user string containing the LITERAL 6-char sequence \\u001e is not altered", () => {
    // The user typed backslash-u-0-0-1-e; JSON escaping makes it \\u001e on the wire — it
    // matches the cheap includes() probe, so this proves the resolve pass is a no-op on it
    // (no real sentinel byte → nothing rewritten, bytes identical).
    const message = { text: "grep for \\u001e in the logs" };
    expect(parser().encode(message)).toBe(JSON.stringify(message));
  });

  it("a stray REAL record-separator byte in user data (not a token) survives unharmed", () => {
    const rs = String.fromCharCode(0x1e);
    const message = { text: `csv${rs}chunk${rs}`, n: 7 };
    setLocale("ru");
    const decoded = JSON.parse(String(parser().encode(message))) as typeof message;
    expect(decoded.text).toBe(`csv${rs}chunk${rs}`);
    expect(decoded.n).toBe(7);
  });

  it("a sentinel-delimited JSON WITHOUT the magic tag is foreign — left exactly as-is", () => {
    const rs = String.fromCharCode(0x1e);
    const foreign = `${rs}{"e":"x","r":"у"}${rs}`; // valid JSON, but not our token (no t:"ruc1")
    setLocale("ru");
    const decoded = JSON.parse(String(parser().encode({ text: foreign }))) as { text: string };
    expect(decoded.text).toBe(foreign);
  });

  it("toJSON-carrying values (dates) beside a token are already normalized — never corrupted", () => {
    // The resolve pass runs on the serialized TEXT, after every toJSON has fired. A
    // toJSON-carrying value (a Date, a DateTime) next to a token must come out as its
    // serialized string, not a mangled {}.
    const message = {
      at: { toJSON: () => "2026-03-01T00:00:00.000Z" },
      label: Lc("Save", "Сохранить"),
    };
    setLocale("ru");
    const decoded = JSON.parse(String(parser().encode(message))) as { at: string; label: string };
    expect(decoded.at).toBe("2026-03-01T00:00:00.000Z");
    expect(decoded.label).toBe("Сохранить");
  });
});

describe("egress decode — the client→server direction is untouched", () => {
  it("decode is the plain JSON parse", () => {
    const wire = JSON.stringify({ _tag: "Request", payload: { text: "hello" } });
    expect(parser().decode(wire)).toEqual([{ _tag: "Request", payload: { text: "hello" } }]);
  });
});
