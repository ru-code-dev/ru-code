// pixso-move: vendored from apps/web/src/lib/utils.ts — keep in sync
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}
