import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // ru-code: the dev-link (`ru-code-packages` symlink + .pnpmfile.cjs → `link:` deps) makes
  // linked @smart-tools packages (via @t3tools/contracts) resolve `effect` from their repo's
  // node_modules — dedupe forces the host's single (patched) copy.
  resolve: {
    dedupe: ["effect"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
