/**
 * ru-code: "On request" driver cards for the add-provider dialog. This build
 * ships with several upstream drivers DISABLED (their real catalog entries are
 * commented out in providerDriverMeta.ts and the server BUILT_IN_DRIVERS).
 * They still appear in the dialog as non-selectable display cards — same
 * visual treatment as the "Coming Soon" set, but captioned "On request" — so
 * users see the drivers exist and can be enabled on demand. Purely
 * presentational: nothing here enables a provider.
 *
 * @module ru-code/provider-catalog/onRequestDrivers
 */
import { ProviderDriverKind } from "@t3tools/contracts";

import { ClaudeAI, CursorIcon, GrokIcon, type Icon, OpenAI } from "~/components/Icons";

export interface OnRequestDriverOption {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
}

/** The card caption (localized via the dict at build time). */
export const ON_REQUEST_BADGE_LABEL = "On request";

/** Mirrors the commented-out set in providerDriverMeta.ts, same order. */
export const ON_REQUEST_DRIVER_OPTIONS: readonly OnRequestDriverOption[] = [
  {
    value: ProviderDriverKind.make("codex"),
    label: "Codex",
    icon: OpenAI,
  },
  {
    value: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    icon: ClaudeAI,
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    icon: CursorIcon,
  },
  {
    value: ProviderDriverKind.make("grok"),
    label: "Grok",
    icon: GrokIcon,
  },
];
