import { defineConfig } from "vite";

// Sandbox bundle: a single IIFE that runs in the Pixso main thread (node API, no DOM).
export default defineConfig({
  build: {
    target: "esnext",
    minify: true,
    emptyOutDir: false,
    outDir: "dist",
    lib: {
      entry: "src/code/code.ts",
      name: "__pixsoPlugin",
      formats: ["iife"],
      fileName: () => "code.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
