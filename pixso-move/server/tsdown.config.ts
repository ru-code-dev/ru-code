import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  outDir: "dist",
  sourcemap: false,
  clean: true,
  // Bundle every dep so the output is self-contained; keep node:sqlite native.
  noExternal: () => true,
  inlineOnly: false,
  banner: { js: "#!/usr/bin/env node\n" },
});
