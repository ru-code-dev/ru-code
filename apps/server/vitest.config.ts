import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@t3tools\/contracts$/,
        replacement: path.resolve(import.meta.dirname, "../../packages/contracts/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      all: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/testUtils/**", "src/**/Migrations/**"],
    },
  },
});
