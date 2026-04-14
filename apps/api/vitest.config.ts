import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    hookTimeout: 15000,
    // Tests touch the same Postgres — serialize across files to avoid
    // TRUNCATE races between fixture setups.
    fileParallelism: false,
    pool: "forks",
  },
});
