// ru-fork: Lexical decorator for the `#agent-name` chip. Mirrors
// ComposerSlashCommandNode (ru-fork) and ComposerSkillNode (upstream).
// Agent frontmatter `color` is intentionally not applied to the chip —
// see chipStyles.ts for the rationale.

import {
  $applyNodeReplacement,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { type ReactElement } from "react";

import {
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../../components/composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { COMPOSER_INLINE_SUBAGENT_CHIP_CLASS_NAME, SUBAGENT_CHIP_ICON_SVG } from "./chipStyles";

type SerializedComposerSubagentNode = Spread<
  {
    subagentName: string;
    subagentLabel?: string;
    subagentDescription?: string;
    type: "composer-subagent";
    version: 1;
  },
  SerializedLexicalNode
>;

const ComposerSubagentDecorator = (props: {
  subagentLabel: string;
  subagentDescription: string | null;
}) => {
  const chip = (
    <span
      className={COMPOSER_INLINE_SUBAGENT_CHIP_CLASS_NAME}
      contentEditable={false}
      spellCheck={false}
      data-composer-subagent-chip="true"
    >
      <span
        aria-hidden="true"
        className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
        dangerouslySetInnerHTML={{ __html: SUBAGENT_CHIP_ICON_SVG }}
      />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.subagentLabel}</span>
    </span>
  );

  if (!props.subagentDescription) {
    return chip;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top" className="max-w-120 whitespace-normal leading-tight">
        {props.subagentDescription}
      </TooltipPopup>
    </Tooltip>
  );
};

export class ComposerSubagentNode extends DecoratorNode<ReactElement> {
  __subagentName: string;
  __subagentLabel: string;
  __subagentDescription: string | null;

  static override getType(): string {
    return "composer-subagent";
  }

  static override clone(node: ComposerSubagentNode): ComposerSubagentNode {
    return new ComposerSubagentNode(
      node.__subagentName,
      node.__subagentLabel,
      node.__subagentDescription,
      node.__key,
    );
  }

  static override importJSON(serializedNode: SerializedComposerSubagentNode): ComposerSubagentNode {
    return $createComposerSubagentNode(
      serializedNode.subagentName,
      serializedNode.subagentLabel ?? serializedNode.subagentName,
      serializedNode.subagentDescription ?? null,
    ).updateFromJSON(serializedNode);
  }

  constructor(
    subagentName: string,
    subagentLabel: string,
    subagentDescription: string | null,
    key?: NodeKey,
  ) {
    super(key);
    const normalizedName = subagentName.startsWith("agent:")
      ? subagentName.slice("agent:".length)
      : subagentName.startsWith("#")
        ? subagentName.slice(1)
        : subagentName;
    this.__subagentName = normalizedName;
    this.__subagentLabel = subagentLabel;
    this.__subagentDescription = subagentDescription;
  }

  override exportJSON(): SerializedComposerSubagentNode {
    return {
      ...super.exportJSON(),
      subagentName: this.__subagentName,
      subagentLabel: this.__subagentLabel,
      ...(this.__subagentDescription ? { subagentDescription: this.__subagentDescription } : {}),
      type: "composer-subagent",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "inline-flex align-middle leading-none";
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    // Literal text shipped to CLI. `agent:name` (not `#name`) so the
    // server-side CliAdapter can trivially detect it and inject the
    // subagent system-reminder. See userTextSubagentReminder.ts.
    return `agent:${this.__subagentName}`;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): ReactElement {
    return (
      <ComposerSubagentDecorator
        subagentLabel={this.__subagentLabel}
        subagentDescription={this.__subagentDescription}
      />
    );
  }
}

export const $createComposerSubagentNode = (
  subagentName: string,
  subagentLabel: string,
  subagentDescription: string | null,
): ComposerSubagentNode =>
  $applyNodeReplacement(new ComposerSubagentNode(subagentName, subagentLabel, subagentDescription));
