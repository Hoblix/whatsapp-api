/**
 * server.ts — Node.js entry point for ECS Fargate
 *
 * Wraps the Hono app from index.ts with @hono/node-server.
 * Injects process.env as Hono bindings so all c.env.* calls work.
 * Polyfills executionCtx.waitUntil() as fire-and-forget.
 */
import { serve } from "@hono/node-server";
import app from "./index";
import type { Env } from "./env";

const port = Number(process.env.PORT) || 3000;

serve(
  {
    fetch: (req: Request) =>
      app.fetch(
        req,
        // Inject process.env as Hono bindings — all c.env.* calls work
        process.env as unknown as Env,
        // Polyfill executionCtx.waitUntil() for the seeding middleware
        {
          waitUntil: (p: Promise<unknown>) => {
            p.catch((err) => console.error("waitUntil error:", err));
          },
          passThroughOnException: () => {},
        }
      ),
    port,
  },
  (info) => {
    console.log(`🚀 WhatsApp API running on http://0.0.0.0:${info.port}`);
    console.log(`   NODE_ENV : ${process.env.NODE_ENV ?? "development"}`);
    console.log(`   DB       : ${process.env.DATABASE_URL ? "✅ set" : "❌ NOT SET"}`);
  }
);
