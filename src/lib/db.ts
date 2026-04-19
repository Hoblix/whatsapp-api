import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Get the best database URL available.
 * Hyperdrive provides a local connection string that routes through
 * Cloudflare's edge cache — much faster than direct Supabase.
 */
export function getDbUrl(env: { HYPERDRIVE?: { connectionString: string }; DATABASE_URL: string }): string {
  return env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
}

export function createDb(databaseUrl: string) {
  // Don't cache — Hyperdrive connection strings change per request
  const client = postgres(databaseUrl, { prepare: false });
  return drizzle(client, { schema });
}

export function createRawClient(databaseUrl: string) {
  // Don't cache — Hyperdrive connection strings change per request
  return postgres(databaseUrl, { prepare: false });
}

export type Database = ReturnType<typeof createDb>;
export type RawClient = ReturnType<typeof postgres>;

export * from "./schema";
