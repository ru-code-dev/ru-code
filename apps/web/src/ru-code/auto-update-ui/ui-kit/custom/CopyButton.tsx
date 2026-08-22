// ru-code: auto-update ui-kit — inline copy button with a transient «copied» state.
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../button";
import { cn } from "../cn";

export function CopyButton({
  value,
  label = "Copy",
  size = "xs",
  variant = "outline",
  className,
}: {
  value: string;
  label?: string;
  size?: "xs" | "sm" | "icon-xs";
  variant?: "outline" | "ghost" | "secondary";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const iconOnly = size === "icon-xs";

  return (
    <Button
      aria-label={iconOnly ? label : undefined}
      className={cn(copied && "text-success-foreground", className)}
      onClick={() => {
        void navigator.clipboard?.writeText(value).catch(() => undefined);
        setCopied(true);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      }}
      size={size}
      variant={variant}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {iconOnly ? null : copied ? "Copied" : label}
    </Button>
  );
}
