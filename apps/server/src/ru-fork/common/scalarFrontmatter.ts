// ru-fork: strict-subset YAML frontmatter parser shared by every
// `.qwen/<thing>/` file scanner.
//
// 1:1 logic port of skills/parseSkillFrontmatter.ts, parameterized over
// the key-alias map so subagents can supply its own keys (`tools`,
// `color`, etc.). Adds optional flow-array support (`tools: [a, b, c]`)
// — when `arrayKeys` is omitted, behavior is byte-identical to the
// original skills parser.

const FENCE = "---";

const stripQuotes = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed.charAt(0);
    const last = trimmed.charAt(trimmed.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
};

const parseFlowArray = (raw: string): ReadonlyArray<string> | undefined => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return undefined;
  }
  const inner = trimmed.slice(1, -1);
  if (inner.trim().length === 0) {
    return [];
  }
  return inner
    .split(",")
    .map(stripQuotes)
    .filter((s) => s.length > 0);
};

export interface FrontmatterParseConfig {
  /** lowercased raw YAML key → canonical result key */
  readonly keyAliases: ReadonlyMap<string, string>;
  /** canonical keys whose values should be parsed as flow arrays `[a, b]` */
  readonly arrayKeys?: ReadonlySet<string>;
}

/**
 * Extract the frontmatter block of a Markdown source. Returns an empty
 * record when no leading `---` fence is present or the fence is not
 * closed. Never throws.
 */
export const parseScalarFrontmatter = (
  source: string,
  config: FrontmatterParseConfig,
): Record<string, string | ReadonlyArray<string>> => {
  // Normalize line endings — Windows checkouts ship `\r\n`.
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines.length === 0 || lines[0]?.trim() !== FENCE) {
    return {};
  }
  const closeIdx = lines.findIndex((line, idx) => idx > 0 && line.trim() === FENCE);
  if (closeIdx === -1) {
    return {};
  }
  const result: Record<string, string | ReadonlyArray<string>> = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const rawKey = trimmed.slice(0, colon).trim().toLowerCase();
    const canonical = config.keyAliases.get(rawKey);
    if (canonical === undefined) continue;
    const rawValue = trimmed.slice(colon + 1);
    if (config.arrayKeys?.has(canonical)) {
      const arr = parseFlowArray(rawValue);
      if (arr) result[canonical] = arr;
      continue;
    }
    // Original logic: stripQuotes FIRST, then check empty.
    const value = stripQuotes(rawValue);
    if (value.length === 0) continue;
    result[canonical] = value;
  }
  return result;
};
