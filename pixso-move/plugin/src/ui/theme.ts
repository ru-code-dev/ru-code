// The ru-code theme set + apply logic. We can't reuse apps/web's useTheme hook
// here because it persists via localStorage, which throws in the sandboxed Pixso
// plugin iframe. Theme is persisted through clientStorage (the settings blob)
// instead; this module only applies the choice to the DOM and validates values.

export const THEME_NAMES = [
  "ru-fork",
  "aurora",
  "onyx",
  "grayscale",
  "pastel-dreams",
  "vs-code",
  "caffeine",
] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export const THEME_NAME_LABELS: Record<ThemeName, string> = {
  "ru-fork": "Ru Code",
  aurora: "Aurora",
  onyx: "Onyx",
  grayscale: "Grayscale",
  "pastel-dreams": "Pastel Dreams",
  "vs-code": "VS Code",
  caffeine: "Caffeine",
};

export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  system: "Системная",
  light: "Светлая",
  dark: "Тёмная",
};

export const DEFAULT_THEME_NAME: ThemeName = "pastel-dreams";
export const DEFAULT_THEME_MODE: ThemeMode = "system";

export const asThemeName = (value: string): ThemeName =>
  (THEME_NAMES as readonly string[]).includes(value) ? (value as ThemeName) : DEFAULT_THEME_NAME;

export const asThemeMode = (value: string): ThemeMode =>
  (THEME_MODES as readonly string[]).includes(value) ? (value as ThemeMode) : DEFAULT_THEME_MODE;

const prefersDark = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;

// Apply the theme to <html> (data-theme + .dark) — mirrors apps/web applyTheme.
export const applyTheme = (themeName: string, themeMode: string): void => {
  if (typeof document === "undefined") return;
  const mode = asThemeMode(themeMode);
  const dark = mode === "dark" || (mode === "system" && prefersDark());
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.setAttribute("data-theme", asThemeName(themeName));
};
