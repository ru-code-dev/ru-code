import type { StoredSettings } from "../shared/messages.ts";

export const SETTINGS_KEY = "pixso-move.settings";
export const DEFAULT_SERVER_URL = "http://localhost:7787";
export const DEFAULT_THEME_NAME = "pastel-dreams";
export const DEFAULT_THEME_MODE = "system";

const stringOr = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

// Pure: coerce whatever was read from clientStorage into a complete StoredSettings.
// Missing/partial/garbage stored values fall back to safe defaults.
export const parseSettings = (raw: unknown): StoredSettings => {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    serverUrl: stringOr(source["serverUrl"], DEFAULT_SERVER_URL),
    designerId: typeof source["designerId"] === "string" ? source["designerId"] : "",
    themeName: stringOr(source["themeName"], DEFAULT_THEME_NAME),
    themeMode: stringOr(source["themeMode"], DEFAULT_THEME_MODE),
  };
};

// Effectful shells (only place the sandbox touches persistence).
export const loadSettings = async (
  storage: PixsoClientStorage,
): Promise<StoredSettings> => parseSettings(await storage.getAsync(SETTINGS_KEY));

export const saveSettings = async (
  storage: PixsoClientStorage,
  settings: StoredSettings,
): Promise<void> => storage.setAsync(SETTINGS_KEY, settings);
