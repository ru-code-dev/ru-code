import * as path from "node:path";
import { defineConfig } from "vitest/config";

// pixso-move: shared vitest/coverage config. Each package's vitest.config.ts is
// `export default makeVitestConfig(import.meta.dirname)`. See specs/conventions.md §5.
export const makeVitestConfig = (dir: string) =>
  defineConfig({
    resolve: {
      alias: [
        {
          find: /^@pixso-move\/contracts$/,
          replacement: path.resolve(dir, "../contracts/src/index.ts"),
        },
      ],
    },
    test: {
      include: ["tests/**/*.test.ts"],
      testTimeout: 60_000,
      hookTimeout: 60_000,
      coverage: {
        provider: "v8",
        reporter: ["text", "json-summary", "lcov"],
        reportsDirectory: "./coverage",
        all: true,
        include: ["src/**/*.ts"],
        exclude: [
          "src/**/*.test.ts",
          "src/**/testUtils/**",
          "src/persistence/migrations/**",
          "src/vendor/**",
          "src/bin.ts",
          "src/**/*.integration.ts",
        ],
        thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      },
    },
  });
