import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon, ListTodoIcon } from "lucide-react";
import { DISABLE_AUTO_APPROVE } from "../../ru-fork/config";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode: ProviderInteractionMode;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  // Locks the mode radio groups while CLI is actively streaming OR
  // parked on a user request — see ComposerFooterModeControls for
  // rationale. `isParkedOnUser` is the ru-fork addition (see
  // `instrumental/changes/pending-requests-handling.md`); upstream T3
  // left the radios live during parking.
  isStreamingActive: boolean;
  isParkedOnUser: boolean;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const isModeChangeLocked = props.isStreamingActive || props.isParkedOnUser;
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
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Режим</div>
            <MenuRadioGroup
              value={props.interactionMode}
              disabled={isModeChangeLocked}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">Разработка</MenuRadioItem>
              <MenuRadioItem value="plan">Планирование</MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Доступ</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          disabled={isModeChangeLocked}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          <MenuRadioItem value="approval-required">Ручное одобрение</MenuRadioItem>
          <MenuRadioItem value="auto-accept-edits">Авто одобрение</MenuRadioItem>
          {/* ru-fork: full-access locked from the dropdown; gated by DISABLE_AUTO_APPROVE so a single flag covers ChatComposer + CompactComposerControlsMenu */}
          <MenuRadioItem value="full-access" disabled={DISABLE_AUTO_APPROVE}>
            Без ограничений
          </MenuRadioItem>
        </MenuRadioGroup>
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen
                ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
