// ru-code: auto-update ui-kit — credential status card (signed-in / missing / token).
import type { ReactNode } from "react";

import { cn } from "../cn";

export function CredentialCard({
  tone,
  icon,
  title,
  description,
  action,
  className,
}: {
  tone: "success" | "warning";
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border px-3.5 py-3",
        tone === "success"
          ? "border-success/24 bg-success/5 dark:bg-success/8"
          : "border-warning/28 bg-warning/6 dark:bg-warning/10",
        className,
      )}
      data-slot="credential-card"
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg [&_svg:not([class*='size-'])]:size-4",
          tone === "success"
            ? "bg-success/10 text-success-foreground dark:bg-success/16"
            : "bg-warning/12 text-warning-foreground dark:bg-warning/16",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
      {action ? <div className="flex shrink-0 items-center gap-1.5">{action}</div> : null}
    </div>
  );
}
