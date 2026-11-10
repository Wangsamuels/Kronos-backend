import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "sdk/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    env: { NODE_ENV: "test" },
  },
});
