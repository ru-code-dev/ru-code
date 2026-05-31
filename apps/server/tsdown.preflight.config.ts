import { defineConfig } from "tsdown";

// Separate bundle for the install-time preflight. A standalone single file so
// the installer can run `node preflight.mjs` before anything is extracted —
// node built-ins + inlined branding constants, zero node_modules required.
//
// Kept out of the main tsdown.config.ts (which builds dist/bin.mjs) on purpose:
// a second entry there would let rolldown split shared modules into chunks,
// breaking the "one self-contained file" guarantee. `clean: false` so this runs
// AFTER build:bundle without wiping dist/bin.mjs.
export default defineConfig({
  entry: { preflight: "src/ru-fork/preflight/preflight-install.ts" },
  format: ["esm"],
  outDir: "dist",
  sourcemap: false,
  clean: false,
  minify: true,
  // Inline everything (branding constants) into dist/preflight.mjs.
  noExternal: () => true,
  inlineOnly: false,
  checks: {
    legacyCjs: false,
  },
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
