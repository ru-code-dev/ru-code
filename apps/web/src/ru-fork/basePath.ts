// ru-fork: base-path support on the web side.
//
// The server injects `window.__RU_FORK_RUNTIME__.basePath` into
// `index.html` at request time (see
// `apps/server/src/ru-fork/basePath/htmlRewrite.ts`), so a single
// Vite build can be deployed at any URL prefix. `import.meta.env.BASE_URL`
// is NOT used — the prefix is dynamic, not baked in.
//
// Both helpers short-circuit when no prefix is configured, so callers
// can use them unconditionally.

declare global {
  interface Window {
    __RU_FORK_RUNTIME__?: { readonly basePath?: string };
  }
}

export const getBasePath = (): string => {
  if (typeof window === "undefined") return "";
  const value = window.__RU_FORK_RUNTIME__?.basePath;
  return typeof value === "string" ? value : "";
};

export const joinBasePath = (basePath: string, path: string): string => {
  if (basePath.length === 0) return path;
  if (path.length === 0 || path === "/") return basePath;
  return path.startsWith("/") ? `${basePath}${path}` : `${basePath}/${path}`;
};
