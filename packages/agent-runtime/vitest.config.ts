import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.e2e.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    testTimeout: 600_000
  }
});
