import type { CSSProperties, FC } from "react";

import { cn } from "~/lib/utils";
import { getBasePath, joinBasePath } from "~/ru-fork/basePath";

import "./Logo.css";

export const Logo: FC<{
  src: string;
  size?: number;
  className?: string;
}> = ({ src, size = 64, className }) => (
  <div
    className={cn("relative size-[var(--logo-size)] shrink-0", className)}
    style={
      {
        // ru-fork: prefix the base-path at render time — the CSS `url()` mask is
        // produced in JS after the server's HTML rewrite, so absolute asset
        // paths must be joined here to work under `--base-url`.
        "--logo-src": `url(${joinBasePath(getBasePath(), src)})`,
        "--logo-size": `${size}px`,
      } as CSSProperties
    }
  >
    <div
      aria-label="logo"
      className={cn(
        "logo_fx-shimmer absolute inset-0",
        "mask-contain mask-center mask-no-repeat",
        "mask-[var(--logo-src)]",
        "from-destructive to-primary bg-gradient-to-t",
      )}
    />
  </div>
);
