import { serve } from "@hono/node-server";
import app from "./index";
import type { Env } from "./env";
import { runMigrations } from "./lib/migrate";

const port = Number(process.env.PORT) || 3000;

async function start() {
  try {
    await runMigrations();
  } catch (err) {
    console.error("⚠️  Migration error (non-fatal):", err);
  }

  serve(
    {
      fetch: (req: Request) =>
        app.fetch(req, process.env as unknown as Env, {
          waitUntil: (p: Promise<unknown>) => {
            p.catch((err) => console.error("[waitUntil error]", err));
          },
          passThroughOnException: () => {},
        }),
      port,
    },
    (info) => {
      console.log(`🚀 WhatsApp API running on http://0.0.0.0:${info.port}`);
      console.log(`   NODE_ENV : ${process.env.NODE_ENV ?? "development"}`);
      console.log(
        `   DB       : ${process.env.DATABASE_URL ? "✅ set" : "❌ NOT SET"}`
      );
    }
  );
}

start();
