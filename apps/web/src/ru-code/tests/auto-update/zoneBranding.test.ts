// ru-code: ZONE-WIDE branding sentinel for the auto-update feature.
//
// WHAT IT GUARDS
//   The product name and the CLI program name are branding, not copy: they live in
//   ONE file (`ru-code/branding/src/index.ts` — `APP_NAME` / `APP_COMMAND`) so a
//   re-skin is a one-file edit. This test reads every source file of the auto-update
//   zone off DISK (no snapshot, no fixture) and fails on any product literal that was
//   typed into the source instead of interpolated from `@ru-code/branding`.
//
//   Zone = apps/web/src/ru-code/auto-update-ui/** + apps/web/src/ru-code/sw/**
//        + apps/server/src/ru-code/auto-update/**
//   plus their dictionaries under ru-code/localization/dict/<same path>.json (a
//   translation may not smuggle the brand back into the Russian the user reads).
//
//   `swBranding.test.ts` is the narrow companion: it proves the two SW-served HTML
//   pages RENDER with branded values. This one proves the whole zone's SOURCE is free
//   of the literals in the first place.
//
// HOW IT DECIDES
//   Two literal families are searched, and they are judged differently because they
//   mean different things:
//
//   1. the DISPLAY NAME — «Ru Code» (a space between the words, any case). A name with
//      a space is never an identifier, so it is human copy wherever it appears: ALWAYS
//      an offence, comments included.
//
//   2. the COMMAND / SLUG form — `ru-code`, `ru_code`. This one doubles as a machine
//      namespace, so an occurrence is an offence only when it is part of human copy.
//      It is permitted when the token it sits in is:
//        · an UPPER_SNAKE identifier  → env var / constant  (`RU_CODE_APP_ROOT`)
//        · a path or module specifier → `@ru-code/branding`, `~/ru-code/…`,
//          `apps/web/src/ru-code/…` in a comment, `/__ru-code/mirror`
//        · a COMPLETE quoted literal  → protocol key, cache name, on-disk file name
//          (`"ru-code:mirror"`, `"ru-code-sw-v1"`, `"ru_code_update_ed25519"`)
//        · the `// ru-code:` seam-comment prefix — in a real comment, and in the
//          comment lines the wrapper generator emits as strings.
//      Everything else — the brand glued to a sentence, or next to an interpolation —
//      is copy and fails.
//
//   `${…}` interpolations are masked to a filler of the same length first, so a
//   template's literal chunks stay one contiguous token and offsets keep pointing at
//   the real column.
// @effect-diagnostics nodeBuiltinImport:off -- a source-tree sentinel reads files off disk, not in an Effect runtime
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../../../..",
);

const SOURCE_ZONES = [
  "apps/web/src/ru-code/auto-update-ui",
  "apps/web/src/ru-code/sw",
  "apps/server/src/ru-code/auto-update",
] as const;

const DICT_ROOT = "ru-code/localization/dict";
const DICT_ZONES = SOURCE_ZONES.map((zone) => `${DICT_ROOT}/${zone}`);

/** «Ru Code» — the display name. A space (or NBSP) means copy; there is no machine reading. */
const DISPLAY_NAME_RE = /ru[ \u00a0]code/gi;
/** `ru-code` / `ru_code` — the command + on-disk slug, which also names machine things. */
const COMMAND_RE = /ru[-_]code/gi;
/** Either family, for the dictionary side (a dictionary value is display copy, always). */
const ANY_BRAND_RE = /ru[ \u00a0_-]code/i;

/** Stands in for a masked `${…}`: a private-use character, so masking never splits a token. */
const FILLER = "\ue000";
/** Characters that keep a machine token together: identifiers, paths, protocol keys. */
const TOKEN_CHAR = /[\w@~./:\ue000-]/;
/** Characters of ONE identifier inside such a token — `process.env.RU_CODE_X` -> `RU_CODE_X`. */
const SEGMENT_CHAR = /[\w\ue000-]/;
/** Masks `${…}` so a template's literal chunks read as ONE token (same length = same columns). */
const INTERPOLATION_RE = /\$\{[^{}]*\}/g;
const QUOTE = /["'`]/;

function walk(absDir: string, keep: (file: string) => boolean): string[] {
  if (!NodeFS.existsSync(absDir)) return [];
  const out: string[] = [];
  for (const entry of NodeFS.readdirSync(absDir, { withFileTypes: true })) {
    const abs = NodePath.join(absDir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, keep));
    else if (keep(entry.name)) out.push(abs);
  }
  return out;
}

const maskInterpolations = (line: string): string =>
  line.replace(INTERPOLATION_RE, (match) => FILLER.repeat(match.length));

/** The maximal run of `chars` around [start, end). */
function runAround(line: string, start: number, end: number, chars: RegExp) {
  let from = start;
  let to = end;
  while (from > 0 && chars.test(line[from - 1] as string)) from -= 1;
  while (to < line.length && chars.test(line[to] as string)) to += 1;
  return { text: line.slice(from, to), before: line[from - 1] ?? "", after: line[to] ?? "" };
}

function isMachineToken(masked: string, start: number, end: number): boolean {
  const { text, before, after } = runAround(masked, start, end, TOKEN_CHAR);
  // env var / exported constant, alone or as a member: RU_CODE_APP_ROOT, process.env.RU_CODE_X
  if (/^[A-Z0-9_]+$/.test(runAround(masked, start, end, SEGMENT_CHAR).text)) return true;
  // path or module specifier: @ru-code/branding, apps/web/src/ru-code/…, /__ru-code/mirror
  if (/[\w@~.\ue000]\/[\w@~.\ue000]/.test(text)) return true;
  // the ENTIRE quoted literal: "ru-code:mirror", "ru-code-sw-v1", "ru_code_update_ed25519"
  if ((before === "" || QUOTE.test(before)) && (after === "" || QUOTE.test(after))) return true;
  // the `// ru-code:` seam-comment prefix — as a comment, or emitted inside a string
  return masked.slice(0, start).trimEnd().endsWith("//") && masked.startsWith("ru-code:", start);
}

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly literal: string;
  readonly text: string;
}

function scanSource(absFile: string): Offence[] {
  const rel = NodePath.relative(REPO_ROOT, absFile);
  const offences: Offence[] = [];
  NodeFS.readFileSync(absFile, "utf8")
    .split("\n")
    .forEach((raw, index) => {
      const masked = maskInterpolations(raw);
      const hit = (start: number, length: number) =>
        offences.push({
          file: rel,
          line: index + 1,
          literal: raw.slice(start, start + length),
          text: raw.trim(),
        });
      for (const match of masked.matchAll(DISPLAY_NAME_RE)) hit(match.index, match[0].length);
      for (const match of masked.matchAll(COMMAND_RE)) {
        if (isMachineToken(masked, match.index, match.index + match[0].length)) continue;
        hit(match.index, match[0].length);
      }
    });
  return offences;
}

function scanDictionary(absFile: string): Offence[] {
  const rel = NodePath.relative(REPO_ROOT, absFile);
  const raw = NodeFS.readFileSync(absFile, "utf8");
  const lines = raw.split("\n");
  const entries = JSON.parse(raw) as ReadonlyArray<Record<string, unknown>>;
  const offences: Offence[] = [];
  entries.forEach((entry, index) => {
    for (const side of ["en", "ru"] as const) {
      const value = entry[side];
      if (typeof value !== "string") continue;
      const match = ANY_BRAND_RE.exec(value);
      if (match === null) continue;
      const at = lines.findIndex((line) => line.includes(`"${side}"`) && line.includes(value));
      offences.push({
        file: rel,
        line: at === -1 ? index + 1 : at + 1,
        literal: match[0],
        text: `${side}: ${value}`,
      });
    }
  });
  return offences;
}

const report = (offences: readonly Offence[]): string =>
  offences.map((o) => `  ${o.file}:${o.line}  «${o.literal}»  in: ${o.text}`).join("\n");

describe("auto-update zone — no hardcoded product branding", () => {
  const sourceFiles = SOURCE_ZONES.flatMap((zone) =>
    walk(NodePath.join(REPO_ROOT, zone), (name) => name.endsWith(".ts") || name.endsWith(".tsx")),
  );
  const dictFiles = DICT_ZONES.flatMap((zone) =>
    walk(NodePath.join(REPO_ROOT, zone), (name) => name.endsWith(".json")),
  );

  it("reads the zone off disk (the walk is not empty)", () => {
    // Guards the guard: a moved or renamed zone must break loudly, not pass vacuously.
    expect(sourceFiles.length).toBeGreaterThan(50);
    expect(dictFiles.length).toBeGreaterThan(5);
  });

  it("every source file takes the product name and CLI command from @ru-code/branding", () => {
    const offences = sourceFiles.flatMap(scanSource);
    expect(
      offences,
      `Hardcoded product branding — import APP_NAME / APP_COMMAND from "@ru-code/branding"\n` +
        `and interpolate (template literal + a "tpl" dictionary entry with {0}):\n${report(offences)}`,
    ).toEqual([]);
  });

  it("no dictionary entry smuggles the product name back into the shipped copy", () => {
    const offences = dictFiles.flatMap(scanDictionary);
    expect(
      offences,
      `Hardcoded product branding in a dictionary — put {0} in BOTH sides and make the\n` +
        `entry "kind": "tpl", so the source interpolates APP_NAME / APP_COMMAND:\n${report(offences)}`,
    ).toEqual([]);
  });
});
