// ru-code: local copy of the app's `cn` helper so the auto-update ui-kit is
// fully self-contained (no imports from upstream app modules).
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}
