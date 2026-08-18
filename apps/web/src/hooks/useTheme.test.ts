import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// ru-code: appearance moved from localStorage to server-stamped globals. Wrap a window
// stub so the globals derive from (and write back to) the same storage the upstream test
// already sets up — every case keeps its exact meaning, throw paths included (R4).
type RuCodeStorageStub = {
  readonly localStorage: {
    getItem(key: string): string | null;
    setItem?(key: string, value: string): void;
  };
};
function ruCodeWindow<T extends RuCodeStorageStub>(base: T) {
  const store = base.localStorage;
  const accessor = (key: string) => ({
    get: () => store.getItem(key) ?? "",
    set: (value: string) => store.setItem?.(key, value),
    enumerable: true,
    configurable: true,
  });
  return Object.defineProperties(
    { ...base },
    {
      __RU_THEME_PREFERENCE__: accessor(THEME_PREFERENCE_KEY),
      __RU_THEME_APPEARANCE_MODE__: accessor(THEME_APPEARANCE_MODE_KEY),
      __RU_THEME_FOLLOW_SYSTEM__: accessor(THEME_FOLLOW_SYSTEM_KEY),
      __RU_THEME_HALVES__: accessor(THEME_HALVES_KEY),
      __RU_CUSTOM_THEMES__: accessor(CUSTOM_THEMES_KEY),
    },
  ) as T;
}
import {
  CUSTOM_THEMES_KEY,
  THEME_APPEARANCE_MODE_KEY,
  THEME_FOLLOW_SYSTEM_KEY,
  THEME_HALVES_KEY,
  THEME_PREFERENCE_KEY,
} from "../ru-code/theme/appearanceStore"; // ru-code: appearance is server-owned

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme failure handling", () => {
  it("preserves exact storage causes and operation context", async () => {
    const readCause = new Error("storage read blocked");
    const writeCause = new Error("storage quota exceeded");
    vi.stubGlobal(
      "window",
      ruCodeWindow({
        localStorage: createStorage({
          getItem: () => {
            throw readCause;
          },
          setItem: () => {
            throw writeCause;
          },
        }),
      }),
    );

    const { readThemePreference, ThemeStorageError, writeThemePreference } =
      await import("./useTheme");

    try {
      readThemePreference();
      expect.unreachable("expected the theme read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: THEME_PREFERENCE_KEY,
        cause: readCause,
      });
    }

    try {
      writeThemePreference("dark");
      expect.unreachable("expected the theme write to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "write",
        storageKey: THEME_PREFERENCE_KEY,
        theme: "dark",
        cause: writeCause,
      });
    }
  });

  it("reads the persisted T3 Chat theme preference", async () => {
    vi.stubGlobal(
      "window",
      ruCodeWindow({
        localStorage: createStorage({
          getItem: () => "t3-chat",
        }),
      }),
    );

    const { readThemePreference } = await import("./useTheme");

    expect(readThemePreference()).toBe("t3-chat");
  });

  it("falls back during initial theme application and logs only safe attributes", async () => {
    const cause = new Error("private browsing storage failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "window",
      ruCodeWindow({
        localStorage: createStorage({
          getItem: () => {
            throw cause;
          },
        }),
        matchMedia: () => ({ matches: false }),
      }),
    );
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle: vi.fn() },
      },
    });

    await expect(import("./useTheme")).resolves.toBeDefined();

    expect(errorLog).toHaveBeenCalledWith(
      `Failed to read theme preference for ${THEME_PREFERENCE_KEY}.`,
      expect.objectContaining({
        operation: "read",
        storageKey: THEME_PREFERENCE_KEY,
        errorTag: "ThemeStorageError",
      }),
    );
    const attributes = errorLog.mock.calls[0]?.[1];
    expect(attributes).not.toHaveProperty("cause");
    expect(JSON.stringify(attributes)).not.toContain(cause.message);
  });

  it("retries a failed storage read only after a relevant storage event", async () => {
    const cause = new Error("persistent storage failure");
    const themeGetItem = vi.fn((): string | null => {
      throw cause;
    });
    const getItem = vi.fn((key: string) => (key === THEME_PREFERENCE_KEY ? themeGetItem() : null));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let readSnapshot: (() => unknown) | undefined;
    let subscribeToTheme: ((listener: () => void) => () => void) | undefined;
    let storageHandler: ((event: StorageEvent) => void) | undefined;
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => {
        subscribeToTheme = subscribe;
        readSnapshot = getSnapshot;
        return getSnapshot();
      },
    }));
    vi.stubGlobal(
      "window",
      ruCodeWindow({
        addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
          if (type === "storage") storageHandler = listener;
        },
        localStorage: createStorage({ getItem }),
        matchMedia: () => ({
          matches: false,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }),
        removeEventListener: () => undefined,
      }),
    );

    const { useTheme } = await import("./useTheme");
    useTheme();
    readSnapshot?.();
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);

    const unsubscribe = subscribeToTheme?.(() => undefined);
    storageHandler?.({ key: THEME_PREFERENCE_KEY } as StorageEvent);
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(2);
    unsubscribe?.();
  });

  it("preserves desktop sync causes and retries after a failed cosmetic sync", async () => {
    const cause = new Error("desktop IPC unavailable");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const setTheme = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", { desktopBridge: { setTheme } });

    const { DesktopThemeSyncError, syncDesktopTheme, syncDesktopThemePreference } =
      await import("./useTheme");

    const error = await syncDesktopThemePreference({ setTheme }, "dark").then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DesktopThemeSyncError);
    expect(error).toMatchObject({ theme: "dark", cause });

    setTheme.mockClear();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();

    expect(setTheme).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to sync the dark theme to the desktop shell.",
      expect.objectContaining({
        theme: "dark",
        errorTag: "DesktopThemeSyncError",
      }),
    );
    for (const [, attributes] of errorLog.mock.calls) {
      expect(attributes).not.toHaveProperty("cause");
      expect(JSON.stringify(attributes)).not.toContain(cause.message);
    }
  });
});
