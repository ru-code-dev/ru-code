import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
// ru-code: shared mode-control catalogs + change guard (R6) — no duplicated option JSX.
import {
  INTERACTION_MODE_OPTIONS,
  resolveRuntimeModeOptions,
  shouldApplyModeControlChange,
} from "../../ru-code/composer/modeControls";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  // ru-code (M6): lock the mode radio groups while a turn streams.
  // ru-code (M5): additionally lock the full-access option for providers that
  // forbid it. Both default to enabled/allowed for every non-qwen provider.
  modeControlsDisabled: boolean;
  fullAccessDisabled: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              disabled={props.modeControlsDisabled}
              onValueChange={(value) => {
                if (!shouldApplyModeControlChange(value, props.interactionMode)) return;
                props.onToggleInteractionMode();
              }}
            >
              {INTERACTION_MODE_OPTIONS.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          disabled={props.modeControlsDisabled}
          onValueChange={(value) => {
            if (!shouldApplyModeControlChange(value, props.runtimeMode)) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          {/* ru-code (M5): full-access locked for providers that forbid it. */}
          {resolveRuntimeModeOptions({ fullAccessDisabled: props.fullAccessDisabled }).map(
            (option) => (
              <MenuRadioItem key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </MenuRadioItem>
            ),
          )}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
