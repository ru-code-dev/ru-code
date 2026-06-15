import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// vite roots on index.html; rename the single emitted HTML to ui.html (manifest refers to it).
const renameToUiHtml = (): Plugin => ({
  name: "pixso-move:rename-ui-html",
  enforce: "post",
  generateBundle(_options, bundle) {
    for (const [key, asset] of Object.entries(bundle)) {
      if (key.endsWith(".html")) asset.fileName = "ui.html";
    }
  },
});

// Iframe bundle: React + Tailwind v4, emitted as one self-contained dist/ui.html.
// `build` emits one self-contained dist/ui.html; `dev` (vite serve) runs the UI
// standalone in the browser so it can be inspected without Pixso (the bridge
// no-ops when there is no plugin host).
export default defineConfig(({ command }) => ({
  root: "src/ui",
  plugins: [
    react(),
    tailwindcss(),
    ...(command === "build" ? [viteSingleFile(), renameToUiHtml()] : []),
  ],
  resolve: { alias: { "~": path.resolve(import.meta.dirname, "src/ui") } },
  build: {
    target: "esnext",
    outDir: "../../dist",
    emptyOutDir: false,
    rollupOptions: { input: "src/ui/index.html" },
  },
}));
