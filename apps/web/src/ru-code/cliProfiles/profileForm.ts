// ru-code: profile-aware overrides for the generic provider settings form. The static
// schema placeholder can't vary by profile, so for a qwen instance we swap the
// binaryPath / homePath placeholders to that profile's bin/dir default — empty for the
// fork ("custom", detected automatically), the stock command/dir for "qwen".
import { resolveCliProfile } from "@ru-code/branding";

import { isCliProfileDriver, readProfileId } from "./profileConfig";

export function withProfilePlaceholders<T extends { readonly key: string }>(
  fields: ReadonlyArray<T>,
  driverKind: unknown,
  config: unknown,
): T[] {
  if (!isCliProfileDriver(driverKind)) return [...fields];
  const profile = resolveCliProfile(readProfileId(config));
  return fields.map((field) => {
    if (field.key === "binaryPath") return { ...field, placeholder: profile.binDefault ?? "" } as T;
    if (field.key === "homePath") return { ...field, placeholder: profile.dirDefault ?? "" } as T;
    return field;
  });
}
