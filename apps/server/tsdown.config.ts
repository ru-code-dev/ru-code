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
  // We bundle every dep on purpose (noExternal above). tsdown warns about that
  // and, because failOnWarn defaults to "ci-only", the warning becomes a hard
  // error under CI=true (passes locally, fails in CI). Disable the check.
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
