import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

const app = new Hono();

app.use("*", logger());

app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN || "https://whatsapp.hoblix.com",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));

export default app;
