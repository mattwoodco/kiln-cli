import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type KilnDb = NodePgDatabase<typeof schema>;

let cachedPool: pg.Pool | null = null;
let cachedDb: KilnDb | null = null;

export function getPool(): pg.Pool {
  if (cachedPool) return cachedPool;
  const connectionString = process.env.DATABASE_URL ?? "postgres://kiln:kiln@localhost:5432/kiln";
  cachedPool = new pg.Pool({ connectionString, max: 10 });
  return cachedPool;
}

export function getDb(): KilnDb {
  if (cachedDb) return cachedDb;
  cachedDb = drizzle(getPool(), { schema });
  return cachedDb;
}

export async function closeDb(): Promise<void> {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
    cachedDb = null;
  }
}

export { schema };
