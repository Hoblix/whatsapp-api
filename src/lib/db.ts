import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("â ï¸  DATABASE_URL not set â DB calls will fail at runtime");
}

const isProduction = process.env.NODE_ENV === "production";

const client = postgres(DATABASE_URL ?? "postgresql://localhost/notset", {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 5,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  onnotice: () => {},
});

export const db = drizzle(client);

export function getDbUrl(): string {
  return DATABASE_URL ?? "";
}
