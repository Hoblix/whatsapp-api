import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { HonoEnv } from "./env";
import { requireAuth } from "./middleware/requireAuth";
import { createDb, getDbUrl } from "./lib/db";
import healthRoutes from "./routes/health";
import authRoutes from "./routes/auth";
import webhookRoutes from "./routes/webhook";
import conversationsRoutes from "./routes/conversations";
import adminRoutes from "./routes/admin";
import sendRoutes from "./routes/send";
import mediaRoutes from "./routes/media";
import notificationsRoutes from "./routes/notifications";
import flowEndpointRoutes from "./routes/flowEndpoint";
import flowTenantsRoutes from "./routes/flowTenants";
import flowDefinitionsRoutes from "./routes/flowDefinitions";
import flowScreensRoutes from "./routes/flowScreens";
import flowIntegrationsRoutes from "./routes/flowIntegrations";
import ctwaRoutes from "./routes/ctwa";
import adsRoutes from "./routes/ads";
import automationsRoutes from "./routes/automations";
import flowSchemaSyncRoutes from "./routes/flowSchemaSync";
import templateRoutes from "./routes/templates";
import credentialRoutes from "./routes/credentials";

const app = new Hono<HonoEnv>();

// ── Security headers ────────────────────────────────────────────────────────
app.use("*", secureHeaders({
  xFrameOptions: "DENY",
  xContentTypeOptions: "nosniff",
  referrerPolicy: "strict-origin-when-cross-origin",
  strictTransportSecurity: "max-age=31536000; includeSubDomains",
}));

// ── CORS ────────────────────────────────────────────────────────────────────
app.use(
  "/api/*",
  cors({
    credentials: true,
    origin: (origin) => {
      if (!origin) return origin;
      const allowed =
        origin === "https://whatsapp.hoblix.com" ||
        origin === "https://hoblix.com" ||
        origin.endsWith(".hoblix.com") ||
        origin.endsWith(".pages.dev") ||
        origin.endsWith(".workers.dev") ||
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1");
      return allowed ? origin : null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Hub-Signature-256"],
    maxAge: 86400,
  })
);

// ── Global error handler ────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error(`[${c.req.method}] ${c.req.path}:`, err.message);
  return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

// ── Body size limit ─────────────────────────────────────────────────────────
app.use("/api/*", async (c, next) => {
  const cl = c.req.header("content-length");
  if (cl && parseInt(cl) > 1_048_576) {
    return c.json({ error: "Request body too large" }, 413);
  }
  await next();
});

// ── Seed super admin (fire-and-forget — don't block requests) ──────────────
let seeded = false;
app.use("/api/*", async (c, next) => {
  if (!seeded) {
    seeded = true;
    const seedFn = async () => {
      const { seedSuperAdmin, seedApiKey } = await import("./lib/seedAdmin");
      const db = createDb(getDbUrl(c.env));
      const phone = (c.env.SUPER_ADMIN_PHONE ?? "919654677563").replace(/\D/g, "");
      await seedSuperAdmin(db, phone).catch(console.error);
      await seedApiKey(db).catch(console.error);
    };
    // waitUntil if available (Cloudflare), otherwise fire-and-forget
    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(seedFn());
    } else {
      seedFn().catch(console.error);
    }
  }
  await next();
});

// ── Public routes ───────────────────────────────────────────────────────────
app.route("/api", healthRoutes);
app.route("/api", webhookRoutes);
app.route("/api", authRoutes);
app.route("/api", flowEndpointRoutes);

// ── Protected routes ────────────────────────────────────────────────────────
app.use("/api/admin/*", requireAuth);
app.use("/api/conversations/*", requireAuth);
app.use("/api/backups/*", requireAuth);
app.use("/api/notifications/*", requireAuth);
app.use("/api/send/*", requireAuth);
app.use("/api/templates", requireAuth);
app.use("/api/media/*", requireAuth);
app.use("/api/api-key", requireAuth);
app.use("/api/messages/*", requireAuth);
app.use("/api/flows/tenants/*", requireAuth);
app.use("/api/flows/integrations/*", requireAuth);
app.use("/api/flows/defaults", requireAuth);
app.use("/api/ctwa/*", requireAuth);
app.use("/api/ads/*", requireAuth);
app.use("/api/automations/*", requireAuth);
app.use("/api/flows/:flowId/sync", requireAuth);
app.use("/api/templates/enriched", requireAuth);
app.use("/api/credentials/*", requireAuth);
app.use("/api/credentials", requireAuth);

app.route("/api", adminRoutes);
app.route("/api", conversationsRoutes);
app.route("/api", sendRoutes);
app.route("/api", mediaRoutes);
app.route("/api", notificationsRoutes);
app.route("/api", flowTenantsRoutes);
app.route("/api", flowDefinitionsRoutes);
app.route("/api", flowScreensRoutes);
app.route("/api", flowIntegrationsRoutes);
app.route("/api", ctwaRoutes);
app.route("/api", adsRoutes);
app.route("/api", automationsRoutes);
app.route("/api", flowSchemaSyncRoutes);
app.route("/api", templateRoutes);
app.route("/api", credentialRoutes);

// ── WebSocket endpoint ──────────────────────────────────────────────────────
// Cloudflare only: proxies to WEBHOOK_HUB Durable Object.
// On Node.js (ECS), WebSocket connections are handled by API Gateway separately.
app.get("/api/ws", (c) => {
  if (!c.env.WEBHOOK_HUB) {
    // Running on Node.js — WebSocket handled by API Gateway WebSocket API
    return c.json({ error: "Connect via wss:// WebSocket endpoint" }, 426);
  }
  const upgrade = c.req.header("Upgrade");
  if (upgrade !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }
  const id = c.env.WEBHOOK_HUB.idFromName("default");
  const stub = c.env.WEBHOOK_HUB.get(id);
  return stub.fetch(new Request(new URL(c.req.url).origin + "/ws", c.req.raw));
});

// ── Manual trigger for missed-call notifier ─────────────────────────────────
app.post("/api/jobs/missed-call-notifier/run", async (c) => {
  const { runMissedCallNotifier } = await import("./jobs/missedCallNotifier");
  const result = await runMissedCallNotifier(c.env as any);
  return c.json(result);
});

// ── Webhook: Notion → missed-call notifier ──────────────────────────────────
app.post("/api/webhooks/notion/missed-call", async (c) => {
  const provided = c.req.header("x-webhook-secret");
  const expected = (c.env as any).MAKE_WEBHOOK_SECRET;
  if (!expected || !provided || provided !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  let body: any = {};
  try { body = await c.req.json(); } catch {}
  const pageId = body?.page_id ?? body?.pageId ?? body?.data?.id ?? body?.page?.id ?? body?.id ?? null;
  if (!pageId) {
    return c.json({ ok: false, error: "page_id required", received: body }, 400);
  }
  const { notifyForSinglePage } = await import("./jobs/missedCallNotifier");
  const result = await notifyForSinglePage(c.env as any, String(pageId));
  return c.json(result, result.ok ? 200 : 400);
});

// ── Export ─────────────────────────────────────────────────────────────────
// Default export is the Hono app.
// src/server.ts wraps this with @hono/node-server for ECS.
// Cloudflare Workers: wrangler uses app.fetch directly.
export default app;
