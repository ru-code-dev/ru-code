// ru-code: auto-update ui-kit — tinted inline callout (trust note, warnings, errors).
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../cn";

export type CalloutTone = "info" | "success" | "warning" | "destructive" | "primary";

const TONE: Record<CalloutTone, { box: string; icon: string }> = {
  info: { box: "border-info/24 bg-info/6 dark:bg-info/10", icon: "text-info-foreground" },
  success: {
    box: "border-success/24 bg-success/6 dark:bg-success/10",
    icon: "text-success-foreground",
  },
  warning: {
    box: "border-warning/28 bg-warning/6 dark:bg-warning/10",
    icon: "text-warning-foreground",
  },
  destructive: {
    box: "border-destructive/28 bg-destructive/6 dark:bg-destructive/10",
    icon: "text-destructive-foreground",
  },
  primary: { box: "border-primary/24 bg-primary/6 dark:bg-primary/10", icon: "text-primary" },
};

/**
 * `...rest` is forwarded on purpose. TypeScript accepts hyphenated JSX attributes a props type does
 * not declare, so `data-testid` on a Callout compiled fine and React silently dropped it — the two
 * hero callouts that carry one (`auto-update-refusal`, `auto-update-blocked`) were unfindable in
 * every browser spec, a blind spot no gate could report. Forwarding costs nothing and makes the
 * attributes mean what they say.
 */
export function Callout({
  tone = "info",
  icon,
  title,
  children,
  action,
  className,
  ...rest
}: {
  tone?: CalloutTone;
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  // `title` is omitted from the DOM attributes on purpose: this component's `title` is a rendered
  // heading (a ReactNode), not the browser's tooltip string, and intersecting the two produces
  // `ReactNode & string` — a type no caller can satisfy.
} & Omit<HTMLAttributes<HTMLDivElement>, "title">) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border px-3.5 py-3 text-[13px] leading-relaxed",
        TONE[tone].box,
        className,
      )}
      data-slot="callout"
      {...rest}
    >
      {icon ? (
        <span
          className={cn("mt-0.5 shrink-0 [&_svg:not([class*='size-'])]:size-4", TONE[tone].icon)}
        >
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        {title ? <div className="font-medium text-foreground">{title}</div> : null}
        {children ? <div className="text-muted-foreground">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}
