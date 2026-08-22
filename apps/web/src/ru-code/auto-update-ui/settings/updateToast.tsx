// ru-code: the auto-update notifications' PURE presentation — the two toast
// builders the app-root driver (notify/autoUpdateDriver) fires through the app's
// REAL toast system (toastManager is mounted in __root, so a toast shows on any
// screen). No fixtures, no demo triggers, no snooze mock (audit #6): every fact
// and callback is passed in by the driver from the live wire state.

import type { ComponentPropsWithoutRef } from "react";
import { ArrowUpCircleIcon, CircleAlertIcon } from "lucide-react";

import { stackedThreadToast, toastManager } from "../../../components/ui/toast";

/**
 * A toast action button's props with a stable e2e testid. `data-*` is a JSX-only
 * allowance absent from the plain `ComponentPropsWithoutRef<"button">` object type,
 * so the testid is attached here through one narrow cast.
 */
function action(
  testId: string,
  label: string,
  onClick: () => void,
): ComponentPropsWithoutRef<"button"> {
  return { "data-testid": testId, children: label, onClick } as ComponentPropsWithoutRef<"button">;
}

/** «Доступна vX» — Установить / Что нового / Позже, over the real release facts. */
export function showUpdateAvailableToast(options: {
  version: string;
  releasedAgo: string;
  sizeMb: number;
  onInstall: () => void;
  onShowNotes: () => void;
  onLater: () => void;
}) {
  let id: ReturnType<typeof toastManager.add> | null = null;
  const close = () => {
    if (id !== null) toastManager.close(id);
  };
  id = toastManager.add(
    stackedThreadToast({
      type: "info",
      title: `Available version v${options.version}`,
      description: `Released ${options.releasedAgo} · ${options.sizeMb} MB. Installation — only after your confirmation.`,
      timeout: 30_000,
      actionProps: action("auto-update-toast-install", "Update", () => {
        close();
        options.onInstall();
      }),
      data: {
        leadingIcon: <ArrowUpCircleIcon className="size-4 text-primary" />,
        secondaryActionProps: action("auto-update-toast-notes", "What's new", () => {
          close();
          options.onShowNotes();
        }),
        additionalActions: [
          {
            id: "auto-update-later",
            props: action("auto-update-toast-later", "Later", () => {
              close();
              options.onLater();
            }),
          },
        ],
      },
    }),
  );
}

/** «Настройте обновления» — the master problem toast; single Настроить action. */
export function showUpdateProblemsToast(options: { onConfigure: () => void }) {
  let id: ReturnType<typeof toastManager.add> | null = null;
  const close = () => {
    if (id !== null) toastManager.close(id);
  };
  id = toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: "Set up updates",
      description: "No update source is working right now — new versions cannot arrive.",
      timeout: 30_000,
      actionProps: action("auto-update-toast-configure", "Configure", () => {
        close();
        options.onConfigure();
      }),
      data: {
        leadingIcon: <CircleAlertIcon className="size-4 text-warning" />,
      },
    }),
  );
}
