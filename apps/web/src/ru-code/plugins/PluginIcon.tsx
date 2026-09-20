// ru-code v2 (decision V2-6): an icon in a host menu is a lucide NAME, rendered by the host.
//
// WHY. v1 let a plugin hand the host a React COMPONENT for every icon — a panel's, a composer
// row's — and one of those paths rendered it unwrapped, so a throwing glyph took the composer (the
// app's most load-bearing component) down. Wrapping the fifth surface would have fixed that
// instance; taking plugin React out of host menus entirely fixes the class. A name is a string: it
// cannot throw, cannot suspend, cannot hold a closure over the plugin's state, and it costs the
// plugin bundle nothing because the host already ships lucide.
//
// A name this build does not know renders the fallback glyph. Never a throw, never an empty slot:
// a plugin built against a newer lucide must degrade, not disappear.

import type { IconName } from "@smart-tools/plugin-sdk/host";
import { PuzzleIcon, icons } from "lucide-react";
import type { ComponentType } from "react";

/**
 * The icon props every host slot passes and every lucide icon accepts.
 *
 * It is the app's own `OverlayPanelIcon` shape (`skills-agents/rightGlobalPanel/registry.tsx`), so
 * a component built here drops into that slot without a cast.
 */
type IconProps = {
  readonly className?: string;
  readonly size?: number | string;
  readonly strokeWidth?: number;
};

/**
 * lucide's own name → component map.
 *
 * `lucide-react`'s `icons` export is keyed in PascalCase (`Puzzle`, `ChartBar`). Kebab-case is
 * accepted too, because that is how lucide's website and its docs spell an icon and it is the
 * spelling a plugin author is most likely to copy.
 */
const pascalCase = (name: string): string =>
  name
    .split(/[-_\s]+/)
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

const registry = icons as unknown as Readonly<Record<string, ComponentType<IconProps>>>;

/** The component for a lucide icon name, or `null` when this build has no such icon. */
export function resolvePluginIcon(name: IconName | undefined): ComponentType<IconProps> | null {
  if (typeof name !== "string" || name.trim() === "") return null;
  return registry[name] ?? registry[pascalCase(name)] ?? null;
}

export interface PluginIconProps {
  /** A `lucide-react` icon name. Unknown or absent ⇒ the plugin family's puzzle glyph. */
  readonly name?: IconName | undefined;
  readonly className?: string | undefined;
  readonly size?: number | string | undefined;
  readonly strokeWidth?: number | undefined;
}

/**
 * Render a plugin's icon by name, falling back to the plugin-family puzzle glyph.
 *
 * The props are spread only when they are set: lucide's own props are non-optional under
 * `exactOptionalPropertyTypes`, so passing `size: undefined` explicitly is a type error where
 * omitting the key is not — and every caller here has an optional icon.
 */
export function PluginIcon({ name, className, size, strokeWidth }: PluginIconProps) {
  const Icon = resolvePluginIcon(name) ?? PuzzleIcon;
  return (
    <Icon
      {...(className === undefined ? {} : { className })}
      {...(size === undefined ? {} : { size })}
      {...(strokeWidth === undefined ? {} : { strokeWidth })}
    />
  );
}

/**
 * The same thing as a COMPONENT, for a host slot that takes one (the overlay-panel registry's
 * `icon` field). The name is closed over, so nothing plugin-authored is mounted.
 */
export const pluginIconComponent =
  (name: IconName | undefined): ComponentType<IconProps> =>
  (props: IconProps) => <PluginIcon name={name} {...props} />;
