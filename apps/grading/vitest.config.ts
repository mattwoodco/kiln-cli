import { defineConfig } from "vitest/config";

/**
 * Vitest 4 projects layout:
 *   - "unit"       — all the flat `test/*.test.ts` files (Phase 1-7.5).
 *   - "regression" — the Phase 8 gold-set regression suite under
 *                    `test/regression/**`. Runs only when explicitly
 *                    selected via `bunx vitest --project regression` or
 *                    the root `bun run ci:regression` script.
 *
 * The top-level `test` block configures shared options (timeouts, pool,
 * environment). Individual projects inherit these and then override
 * `name`/`include`/`exclude`.
 */
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/*.test.ts"],
          environment: "node",
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      {
        test: {
          name: "regression",
          include: ["test/regression/**/*.test.ts"],
          environment: "node",
          testTimeout: 180000,
          hookTimeout: 60000,
        },
      },
    ],
  },
});
