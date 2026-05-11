// ru-fork: unified local-startup defaults. Pinned here so the t3-shared
// cli/config.ts and config.ts hold no ru-fork-specific values inline.
//
// Sibling-but-separate from `apps/server/src/ru-fork/startup/` (which
// owns the node/git/CLI prerequisite preflight gate). That gate answers
// "is this machine set up to run ru-fork?"; the constants and helper
// here answer "can the desktop-mode server actually bind to its address?".
//
// `as const` on DESKTOP_RUNTIME_MODE is structural: it feeds the
// `RuntimeMode = "web" | "desktop"` union at the default-mode fallback,
// which won't accept a widened `string`.
export const DESKTOP_RUNTIME_MODE = "desktop" as const;
export const DESKTOP_LOOPBACK_HOST = "127.0.0.1";

// Surfaced when desktop mode hits an occupied port. Desktop mode binds
// DEFAULT_PORT verbatim (no findAvailablePort fallback), so collisions
// must be communicated clearly to the user.
export const PORT_IN_USE_ERROR_RU = (port: number): string =>
  `Порт ${port} уже занят. Остановите процесс, который его использует, ` +
  `или запустите с флагом --port <другой_порт>.`;
