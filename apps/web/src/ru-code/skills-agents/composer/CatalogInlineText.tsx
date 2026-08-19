// ru-code: sent-message (bubble) renderer for catalog chips. Uses the package's ONE name-independent
// delimited parser (parseCatalogTokenSegments) — shared with the composer editor — so a `skill:⟦name⟧` /
// `agent:⟦name⟧` token renders as a chip regardless of the current catalog (spaces- and deletion-safe; a
// removed item just shows its raw name). Distinct from the port's native `$skill` bubble (SkillInlineText),
// which stays for non-catalog providers.
import { Children, cloneElement, isValidElement, type ReactNode } from "react";

import {
  parseCatalogTokenSegments,
  buildCatalogToken,
  formatCatalogItemDisplayName,
} from "@smart-tools/qwen-cli-catalog-core/contracts";
import {
  CHAT_INLINE_CHIP_CLASS_NAME,
  CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "~/components/composerInlineChip";
import { cn } from "~/lib/utils";

import { SUBAGENT_CHIP_ICON_SVG } from "./chipStyles";

const CHIP_STYLE = {
  skill: {
    className: "border-fuchsia-500/25 bg-fuchsia-500/12 text-fuchsia-700 dark:text-fuchsia-300",
    iconSvg: SKILL_CHIP_ICON_SVG,
  },
  agent: {
    className: "border-emerald-500/25 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    iconSvg: SUBAGENT_CHIP_ICON_SVG,
  },
} as const;

function CatalogChip(props: { kind: "skill" | "agent"; label: string; rawText: string }) {
  const style = CHIP_STYLE[props.kind];
  return (
    <span className="inline-flex align-middle leading-none" data-markdown-copy={props.rawText}>
      <span className={cn(CHAT_INLINE_CHIP_CLASS_NAME, style.className)}>
        <span
          aria-hidden="true"
          className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
          dangerouslySetInnerHTML={{ __html: style.iconSvg }}
        />
        <span className={CHAT_INLINE_CHIP_LABEL_CLASS_NAME}>{props.label}</span>
      </span>
    </span>
  );
}

export function CatalogInlineText(props: { text: string }) {
  const segments = parseCatalogTokenSegments(props.text);
  if (!segments.some((segment) => segment.kind === "chip")) {
    return <>{props.text}</>;
  }
  const nodes: ReactNode[] = [];
  for (const segment of segments) {
    if (segment.kind === "text") {
      nodes.push(segment.text);
      continue;
    }
    const kind = segment.catalogKind;
    nodes.push(
      <CatalogChip
        key={`${kind}:${segment.start}:${segment.name}`}
        kind={kind}
        // ru-code: bubble shows the formatted display; data-markdown-copy keeps the raw wire token.
        label={formatCatalogItemDisplayName(segment.name)}
        rawText={buildCatalogToken(kind, segment.name)}
      />,
    );
  }
  return <>{nodes}</>;
}

export function renderCatalogInlineMarkdownChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <CatalogInlineText text={child} />;
    }
    if (!isValidElement<{ children?: ReactNode }>(child)) {
      return child;
    }
    if (child.type === "code" || child.type === "a") {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderCatalogInlineMarkdownChildren(child.props.children),
    );
  });
}
