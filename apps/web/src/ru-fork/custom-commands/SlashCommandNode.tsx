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
import {
  COMPOSER_INLINE_SLASH_COMMAND_CHIP_CLASS_NAME,
  SLASH_COMMAND_CHIP_ICON_SVG,
} from "./chipStyles";

type SerializedComposerSlashCommandNode = Spread<
  {
    commandName: string;
    commandLabel?: string;
    commandDescription?: string;
    type: "composer-slash-command";
    version: 1;
  },
  SerializedLexicalNode
>;

const ComposerSlashCommandDecorator = (props: {
  commandLabel: string;
  commandDescription: string | null;
}) => {
  const chip = (
    <span
      className={COMPOSER_INLINE_SLASH_COMMAND_CHIP_CLASS_NAME}
      contentEditable={false}
      spellCheck={false}
      data-composer-slash-command-chip="true"
    >
      <span
        aria-hidden="true"
        className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
        dangerouslySetInnerHTML={{ __html: SLASH_COMMAND_CHIP_ICON_SVG }}
      />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.commandLabel}</span>
    </span>
  );

  if (!props.commandDescription) {
    return chip;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top" className="max-w-120 whitespace-normal leading-tight">
        {props.commandDescription}
      </TooltipPopup>
    </Tooltip>
  );
};

export class ComposerSlashCommandNode extends DecoratorNode<ReactElement> {
  __commandName: string;
  __commandLabel: string;
  __commandDescription: string | null;

  static override getType(): string {
    return "composer-slash-command";
  }

  static override clone(node: ComposerSlashCommandNode): ComposerSlashCommandNode {
    return new ComposerSlashCommandNode(
      node.__commandName,
      node.__commandLabel,
      node.__commandDescription,
      node.__key,
    );
  }

  static override importJSON(
    serializedNode: SerializedComposerSlashCommandNode,
  ): ComposerSlashCommandNode {
    return $createComposerSlashCommandNode(
      serializedNode.commandName,
      serializedNode.commandLabel ?? `/${serializedNode.commandName}`,
      serializedNode.commandDescription ?? null,
    ).updateFromJSON(serializedNode);
  }

  constructor(
    commandName: string,
    commandLabel: string,
    commandDescription: string | null,
    key?: NodeKey,
  ) {
    super(key);
    const normalizedName = commandName.startsWith("/") ? commandName.slice(1) : commandName;
    this.__commandName = normalizedName;
    this.__commandLabel = commandLabel;
    this.__commandDescription = commandDescription;
  }

  override exportJSON(): SerializedComposerSlashCommandNode {
    return {
      ...super.exportJSON(),
      commandName: this.__commandName,
      commandLabel: this.__commandLabel,
      ...(this.__commandDescription ? { commandDescription: this.__commandDescription } : {}),
      type: "composer-slash-command",
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
    return `/${this.__commandName}`;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): ReactElement {
    return (
      <ComposerSlashCommandDecorator
        commandLabel={this.__commandLabel}
        commandDescription={this.__commandDescription}
      />
    );
  }
}

export const $createComposerSlashCommandNode = (
  commandName: string,
  commandLabel: string,
  commandDescription: string | null,
): ComposerSlashCommandNode =>
  $applyNodeReplacement(
    new ComposerSlashCommandNode(commandName, commandLabel, commandDescription),
  );
