import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

import { APP_NAME } from "@ru-fork/branding";

// Brand assets live in `@ru-fork/branding` (the single source of truth), NOT in
// apps/web/public. This plugin wires them into the web app without copying into
// the source tree:
//   - dev:   a middleware serves each asset at its public URL
//   - build: each asset is emitted into dist/ at the same path
//   - both:  `/site.webmanifest` is generated from APP_NAME so the PWA name
//            follows branding automatically.
// Because the build emits into apps/web/dist/, the server's existing
// `dist/client` bundling step (apps/server/scripts/cli.ts) picks them up — so
// `pnpm start` serves them with no extra wiring.

const ASSETS_DIR = fileURLToPath(new URL("../../packages/branding/assets/", import.meta.url));

// relative path under the branding assets dir === public URL path
const BRAND_ASSETS = [
  "app-icon-192.png",
  "app-icon-512.png",
  "logo.png",
  "icons/light/favicon-32x32.png",
  "icons/dark/favicon-32x32.png",
  "icons/light/apple-touch-icon.png",
  "icons/dark/apple-touch-icon.png",
] as const;

const MANIFEST_URL = "site.webmanifest";

const contentType = (urlPath: string): string => {
  if (urlPath.endsWith(".png")) return "image/png";
  if (urlPath.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
};

const buildManifest = (): string =>
  JSON.stringify(
    {
      id: "/",
      name: APP_NAME,
      short_name: APP_NAME,
      start_url: "/",
      scope: "/",
      display: "standalone",
      theme_color: "#161616",
      background_color: "#161616",
      icons: [
        { src: "/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      ],
    },
    null,
    2,
  );

export const brandingAssetsPlugin = (): Plugin => ({
  name: "ru-fork-branding-assets",

  // Replace %APP_NAME% tokens in index.html (title, splash labels, etc.).
  transformIndexHtml(html) {
    return html.replaceAll("%APP_NAME%", APP_NAME);
  },

  // Dev: serve branding assets + generated manifest from memory/disk.
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const urlPath = (req.url ?? "").split("?")[0]!.replace(/^\/+/, "");
      if (urlPath === MANIFEST_URL) {
        res.setHeader("Content-Type", contentType(urlPath));
        res.end(buildManifest());
        return;
      }
      if ((BRAND_ASSETS as readonly string[]).includes(urlPath)) {
        res.setHeader("Content-Type", contentType(urlPath));
        res.end(readFileSync(ASSETS_DIR + urlPath));
        return;
      }
      next();
    });
  },

  // Build: emit each asset + the generated manifest into dist/ at its URL path.
  generateBundle() {
    for (const rel of BRAND_ASSETS) {
      this.emitFile({ type: "asset", fileName: rel, source: readFileSync(ASSETS_DIR + rel) });
    }
    this.emitFile({ type: "asset", fileName: MANIFEST_URL, source: buildManifest() });
  },
});
