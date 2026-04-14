import type { Config } from "drizzle-kit";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://kiln:kiln@localhost:5432/kiln";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
  strict: true,
  verbose: true,
} satisfies Config;
