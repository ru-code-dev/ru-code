// ru-fork: unified bubble renderer for the three ru-fork sigils:
//   `/command`   — leading ru-fork custom slash commands
//   `$skill`     — any-position skill chip (mirrors upstream SkillInlineText)
//   `#agent`     — any-position subagent chip
//
// One regex pass scans for `$` + `#` after the optional leading
// `/command` is consumed. Inline JSX for each chip type — class+svg
// constants already shared across the app via composerInlineChip.ts and
// the per-feature chipStyles.ts, so visual drift is impossible.

import { type ReactNode } from "react";
import type { ServerProviderSkill, ServerProviderSubagent } from "@t3tools/contracts";

import { findRuForkBuiltInCommand } from "./commands";
import { RU_FORK_SLASH_COMMAND_BUBBLE_REGEX } from "../unsupported-slash-commands/chipRegex";
import { getSlashCommandSlugForRewriteText } from "../unsupported-slash-commands/rewriteCommands";
import {
  COMPOSER_INLINE_SLASH_COMMAND_CHIP_CLASS_NAME,
  SLASH_COMMAND_CHIP_ICON_SVG,
} from "./chipStyles";
import {
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "../../components/composerInlineChip";
import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import {
  COMPOSER_INLINE_SUBAGENT_CHIP_CLASS_NAME,
  SUBAGENT_CHIP_ICON_SVG,
} from "../subagents/chipStyles";
import { formatProviderSubagentDisplayName } from "../subagents/providerSubagentSearch";

type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;
type InlineSubagent = Pick<ServerProviderSubagent, "name">;

// Matches `$skill` OR `agent:name`. Capture groups:
//   match[1] = leading whitespace (or empty if at start)
//   match[2] = "$" or "" (skill sigil)
//   match[3] = skill name (when match[2] is "$")
//   match[4] = agent name (when not a skill match)
const INLINE_CHIP_TOKEN_REGEX =
  /(^|\s)(?:(\$)([a-zA-Z][a-zA-Z0-9:_-]*)|agent:([a-zA-Z][a-zA-Z0-9_-]*))(?=\s|$)/g;

export const SlashCommandInlineText = (props: {
  text: string;
  skills: ReadonlyArray<InlineSkill>;
  subagents: ReadonlyArray<InlineSubagent>;
}): ReactNode => {
  // ru-fork: short-circuit for rewrite stubs. If the message body equals
  // one of the rewrite phrases (Отобрази список подключенных subagents/...),
  // render the original `/<slug>` chip. The bubble payload is the Russian
  // rewrite (produced by stripUnknownLeadingSlashCommand at submit), so this
  // is the only place that turns it back into a chip for display.
  const rewriteSlug = getSlashCommandSlugForRewriteText(props.text);
  if (rewriteSlug !== undefined) {
    return <SlashCommandChip rawText={`/${rewriteSlug}`} />;
  }

  const nodes: ReactNode[] = [];

  // Step 1: leading `/command` chip (ru-fork custom commands only).
  const slashMatch = RU_FORK_SLASH_COMMAND_BUBBLE_REGEX.exec(props.text);
  const hasSlash = slashMatch && findRuForkBuiltInCommand(slashMatch[1]!);
  const remainder = hasSlash ? props.text.slice(slashMatch![0].length) : props.text;
  if (hasSlash) {
    const raw = `/${slashMatch![1]!}`;
    nodes.push(<SlashCommandChip key="slash" rawText={raw} />);
  }

  // Step 2: single regex pass over the remainder for `$skill` + `agent:name`.
  let cursor = 0;
  for (const match of remainder.matchAll(INLINE_CHIP_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const skillName = match[3];
    const agentName = match[4];
    const start = (match.index ?? 0) + prefix.length;

    if (skillName !== undefined) {
      const skill = props.skills.find((candidate) => candidate.name === skillName);
      if (!skill) continue;
      const raw = `$${skillName}`;
      if (start > cursor) nodes.push(remainder.slice(cursor, start));
      nodes.push(
        <SkillChip
          key={`skill:${start}:${skillName}`}
          label={formatProviderSkillDisplayName(skill)}
          rawText={raw}
        />,
      );
      cursor = start + raw.length;
      continue;
    }
    if (agentName !== undefined) {
      const agent = props.subagents.find((candidate) => candidate.name === agentName);
      if (!agent) continue;
      const raw = `agent:${agentName}`;
      if (start > cursor) nodes.push(remainder.slice(cursor, start));
      nodes.push(
        <SubagentChip
          key={`agent:${start}:${agentName}`}
          label={formatProviderSubagentDisplayName(agent)}
          rawText={raw}
        />,
      );
      cursor = start + raw.length;
    }
  }
  if (cursor < remainder.length) {
    nodes.push(remainder.slice(cursor));
  }
  if (nodes.length === 0) {
    return props.text;
  }
  return <>{nodes}</>;
};

// ── chip leaves ───────────────────────────────────────────────────────
// Three small parallel JSX blocks. Class+svg constants are already
// shared, so the only thing duplicated here is the span-wrapping shape.

const SlashCommandChip = (props: { rawText: string }) => (
  <span className="inline-flex align-middle leading-none">
    <span className="sr-only">{props.rawText}</span>
    <span aria-hidden="true" className={COMPOSER_INLINE_SLASH_COMMAND_CHIP_CLASS_NAME}>
      <span
        aria-hidden="true"
        className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
        dangerouslySetInnerHTML={{ __html: SLASH_COMMAND_CHIP_ICON_SVG }}
      />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.rawText}</span>
    </span>
  </span>
);

const SkillChip = (props: { label: string; rawText: string }) => (
  <span className="inline-flex align-middle leading-none">
    <span className="sr-only">{props.rawText}</span>
    <span aria-hidden="true" className={COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME}>
      <span
        aria-hidden="true"
        className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
        dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
      />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.label}</span>
    </span>
  </span>
);

const SubagentChip = (props: { label: string; rawText: string }) => (
  <span className="inline-flex align-middle leading-none">
    <span className="sr-only">{props.rawText}</span>
    <span aria-hidden="true" className={COMPOSER_INLINE_SUBAGENT_CHIP_CLASS_NAME}>
      <span
        aria-hidden="true"
        className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
        dangerouslySetInnerHTML={{ __html: SUBAGENT_CHIP_ICON_SVG }}
      />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.label}</span>
    </span>
  </span>
);
