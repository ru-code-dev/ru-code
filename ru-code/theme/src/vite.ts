// @effect-diagnostics nodeBuiltinImport:off -- vite build plugin runs in Node, not an Effect runtime
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import type { Plugin } from "vite";

import { APP_NAME, APP_SCOPE } from "@ru-code/branding";

const ASSETS_DIR = NodeURL.fileURLToPath(new URL("../assets/", import.meta.url));

// relative path under the assets dir === public URL path
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
  name: "ru-code-branding-assets",

  // Fill the product-identity tokens in index.html (title, alt, storage-key
  // namespace). Asset links + pre-paint scripts are authored directly in the HTML.
  transformIndexHtml(html) {
    return html.replaceAll("%APP_NAME%", APP_NAME).replaceAll("%APP_SCOPE%", APP_SCOPE);
  },

  // Dev: serve branding assets + generated manifest.
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
        res.end(NodeFS.readFileSync(ASSETS_DIR + urlPath));
        return;
      }
      next();
    });
  },

  // Build: emit each asset + the generated manifest into dist/ at its URL path.
  generateBundle() {
    for (const rel of BRAND_ASSETS) {
      this.emitFile({
        type: "asset",
        fileName: rel,
        source: NodeFS.readFileSync(ASSETS_DIR + rel),
      });
    }
    this.emitFile({ type: "asset", fileName: MANIFEST_URL, source: buildManifest() });
  },
});
