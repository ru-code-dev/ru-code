import { defineConfig } from "vitest/config";

// Plugin pure-helper tests run in plain node (no Pixso runtime, no jsdom needed).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
