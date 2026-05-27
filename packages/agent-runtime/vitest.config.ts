import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.e2e.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    /** Live provider E2E (intake + creator) can exceed 10m on slow proxies (e.g. Claude). */
    testTimeout: 1_200_000
  }
});
