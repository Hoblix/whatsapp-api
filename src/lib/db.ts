import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const isProduction = process.env.NODE_ENV === "production";

const client = postgres(process.env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 5,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  onnotice: () => {},
});

export const db = drizzle(client);

export function getDbUrl(): string {
  return process.env.DATABASE_URL!;
}
