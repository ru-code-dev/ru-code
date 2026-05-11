import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: false,
  clean: true,
  // Inline every npm dep into dist/bin.mjs so the published tarball is
  // self-contained. Only native modules stay external — they ship as
  // platform-specific .node prebuilds that npm/pnpm install at the user's
  // machine.
  noExternal: () => true,
  external: ["node-pty", "msgpackr-extract"],
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
