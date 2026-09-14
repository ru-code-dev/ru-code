// ru-code: the "Reload CLI" action in the sidebar header, right of the app name. Same button +
// tooltip shape as the footer icon row (SidebarChrome's Settings/Analytics), so hover/focus/pressed
// visuals match. Click opens the app's standard AlertDialog confirm; confirm calls the
// `requestCliReload` seam, which runs the server's `cliReload` RPC and resolves only when the
// server is really done. Hidden below `md` like the brand it sits next to.
import { L } from "@ru-code/localization";
import { RotateCcwIcon } from "lucide-react";
import { useCallback, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { SidebarMenuButton } from "~/components/ui/sidebar";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { requestCliReload } from "./reloadCli";

// ru-code zone → hand seam (R19): module-const L is safe — the locale module self-seeds from the
// server-stamped window.__RU_LOCALE__ at its own init (localeInit.test.ts).
export const CLI_RELOAD_COPY = {
  /** Tooltip + aria-label. */
  action: L("Reload CLI", "Перезагрузить CLI"),
  title: L("Reload CLI?", "Перезагрузить CLI?"),
  description: L(
    "All active CLI sessions will be restarted and their authorization refreshed, so agents keep running until the next expiry.",
    "Все активные сессии CLI будут перезапущены, а авторизация обновлена — агенты продолжат работать до следующего истечения срока действия.",
  ),
  cancel: L("Cancel", "Отмена"),
  confirm: L("Reload", "Перезагрузить"),
  /** Owner ruling R7: ONE generic line for every failure — the cause is in the server log. */
  failed: L(
    "Could not reload the CLI. Please try again.",
    "Не удалось перезагрузить CLI. Попробуйте ещё раз.",
  ),
} as const;

export function CliReloadHeaderAction({ onBackdrop }: { onBackdrop: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleConfirm = useCallback(async () => {
    setPending(true);
    setFailed(false);
    try {
      await requestCliReload();
      // The RPC resolves only when the server is really done (owner ruling R2), so closing
      // here is the honest "it finished" signal — no optimistic close, no toast.
      setOpen(false);
    } catch {
      // Owner ruling R7: one generic line, the modal stays open and the buttons come back.
      // The cause is deliberately not read — it never reaches the user.
      setFailed(true);
    } finally {
      setPending(false);
    }
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setFailed(false);
  }, []);

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={CLI_RELOAD_COPY.action}
              className={cn(
                // Sits beside the brand link: same z-layer, same md-only visibility, and opt out of
                // the Electron drag region so the click lands.
                "relative z-10 ml-1 hidden shrink-0 [-webkit-app-region:no-drag] md:inline-flex",
                // On an artwork/stage backdrop mirror SidebarTrigger's white treatment.
                onBackdrop &&
                  "focus-visible:ring-white/90 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white! [:hover,[data-pressed]]:bg-white/15",
              )}
              onClick={() => handleOpenChange(true)}
              size="icon"
            >
              <RotateCcwIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="bottom">{CLI_RELOAD_COPY.action}</TooltipPopup>
      </Tooltip>

      <AlertDialog onOpenChange={handleOpenChange} open={open}>
        <AlertDialogPopup className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{CLI_RELOAD_COPY.title}</AlertDialogTitle>
            <AlertDialogDescription>{CLI_RELOAD_COPY.description}</AlertDialogDescription>
            {failed ? (
              <p className="text-sm text-destructive" data-testid="cli-reload-error">
                {CLI_RELOAD_COPY.failed}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={pending} render={<Button variant="outline" />}>
              {CLI_RELOAD_COPY.cancel}
            </AlertDialogClose>
            <Button
              data-testid="cli-reload-confirm"
              disabled={pending}
              onClick={() => void handleConfirm()}
            >
              {pending ? <Spinner className="size-4" /> : null}
              {CLI_RELOAD_COPY.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
