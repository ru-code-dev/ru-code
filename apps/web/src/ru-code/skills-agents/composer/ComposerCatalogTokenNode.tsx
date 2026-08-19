// ru-code: ONE kind-parameterized Lexical decorator node for the composer's catalog chips (skill AND
// agent). The kind is stored as node data; every skill-vs-agent difference (wire prefix, chip colour +
// glyph, trigger sigil) is resolved from the shared kind table (catalogKindConfig). Serializes to the
// DELIMITED wire token `skill:⟦name⟧` / `agent:⟦name⟧` so the composer AND the bubble re-parse it with the
// package's name-independent parser (spaces- and deletion-safe); the server strips the fences before the
// CLI sees them. The port's own `ComposerSkillNode` stays registered for any native (non-catalog) $skill.

import {
  $applyNodeReplacement,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { type ReactElement } from "react";

import {
  buildCatalogToken,
  catalogKindConfig,
  parseCatalogTokenSegments,
  type CatalogKind,
} from "@smart-tools/qwen-cli-catalog-core/contracts";

import {
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "~/components/composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { COMPOSER_INLINE_SUBAGENT_CHIP_CLASS_NAME, SUBAGENT_CHIP_ICON_SVG } from "./chipStyles";

// Per-kind chip visuals + the DOM marker each chip carries.
const CHIP_PRESENTATION: Record<
  CatalogKind,
  { readonly className: string; readonly iconSvg: string; readonly dataAttr: string }
> = {
  skill: {
    className: COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
    iconSvg: SKILL_CHIP_ICON_SVG,
    dataAttr: "data-composer-skill-chip",
  },
  agent: {
    className: COMPOSER_INLINE_SUBAGENT_CHIP_CLASS_NAME,
    iconSvg: SUBAGENT_CHIP_ICON_SVG,
    dataAttr: "data-composer-subagent-chip",
  },
};

type SerializedComposerCatalogTokenNode = Spread<
  {
    catalogKind: CatalogKind;
    itemName: string;
    itemLabel?: string;
    itemDescription?: string;
    type: "composer-catalog-token";
    version: 1;
  },
  SerializedLexicalNode
>;

function ComposerCatalogTokenDecorator(props: {
  kind: CatalogKind;
  label: string;
  description: string | null;
}) {
  const presentation = CHIP_PRESENTATION[props.kind];
  const chip = (
    <span
      className={presentation.className}
      contentEditable={false}
      spellCheck={false}
      {...{ [presentation.dataAttr]: "true" }}
    >
      <span
        aria-hidden="true"
        className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
        dangerouslySetInnerHTML={{ __html: presentation.iconSvg }}
      />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.label}</span>
    </span>
  );

  if (!props.description) {
    return chip;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top" className="max-w-120 whitespace-normal leading-tight">
        {props.description}
      </TooltipPopup>
    </Tooltip>
  );
}

export class ComposerCatalogTokenNode extends DecoratorNode<ReactElement> {
  __kind: CatalogKind;
  __name: string;
  __label: string;
  __description: string | null;

  static override getType(): string {
    return "composer-catalog-token";
  }

  static override clone(node: ComposerCatalogTokenNode): ComposerCatalogTokenNode {
    return new ComposerCatalogTokenNode(
      node.__kind,
      node.__name,
      node.__label,
      node.__description,
      node.__key,
    );
  }

  static override importJSON(
    serializedNode: SerializedComposerCatalogTokenNode,
  ): ComposerCatalogTokenNode {
    return $createComposerCatalogTokenNode(
      serializedNode.catalogKind,
      serializedNode.itemName,
      serializedNode.itemLabel ?? serializedNode.itemName,
      serializedNode.itemDescription ?? null,
    ).updateFromJSON(serializedNode);
  }

  constructor(
    kind: CatalogKind,
    name: string,
    label: string,
    description: string | null,
    key?: NodeKey,
  ) {
    super(key);
    // Store the BARE name. Accept a bare name, a delimited wire token (`skill:⟦name⟧`), or the legacy
    // trigger sigil (`$name`/`#name`) — normalize all to the bare name.
    const { triggerChar } = catalogKindConfig(kind);
    const chip = parseCatalogTokenSegments(name).find((segment) => segment.kind === "chip");
    const normalized =
      chip?.kind === "chip"
        ? chip.name
        : name.startsWith(triggerChar)
          ? name.slice(triggerChar.length)
          : name;
    this.__kind = kind;
    this.__name = normalized;
    this.__label = label;
    this.__description = description;
  }

  override exportJSON(): SerializedComposerCatalogTokenNode {
    return {
      ...super.exportJSON(),
      catalogKind: this.__kind,
      itemName: this.__name,
      itemLabel: this.__label,
      ...(this.__description ? { itemDescription: this.__description } : {}),
      type: "composer-catalog-token",
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
    // The DELIMITED token shipped in the value string; the server strips the fences before the CLI.
    return buildCatalogToken(catalogKindConfig(this.__kind).wirePrefix, this.__name);
  }

  override isInline(): true {
    return true;
  }

  override decorate(): ReactElement {
    return (
      <ComposerCatalogTokenDecorator
        kind={this.__kind}
        label={this.__label}
        description={this.__description}
      />
    );
  }
}

export const $createComposerCatalogTokenNode = (
  kind: CatalogKind,
  name: string,
  label: string,
  description: string | null,
): ComposerCatalogTokenNode =>
  $applyNodeReplacement(new ComposerCatalogTokenNode(kind, name, label, description));
