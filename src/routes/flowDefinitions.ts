/**
 * Flow definition routes (super-admin only) — Hono / Cloudflare Workers
 *
 * POST   /flows/tenants/:tenantId/flows                 create
 * GET    /flows/tenants/:tenantId/flows                 list
 * GET    /flows/tenants/:tenantId/flows/:flowId         single + stats
 * PATCH  /flows/tenants/:tenantId/flows/:flowId         update
 * DELETE /flows/tenants/:tenantId/flows/:flowId         delete
 *
 * GET    /flows/tenants/:tenantId/analytics             tenant analytics
 * GET    /flows/tenants/:tenantId/flows/:flowId/analytics   flow analytics
 * GET    /flows/tenants/:tenantId/flows/:flowId/submissions paginated submissions
 */

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { eq, and, gt, count, desc, gte, sql } from "drizzle-orm";
import type { HonoEnv } from "../env";
import { createDb, getDbUrl, type Database } from "../lib/db";
import {
  flowTenantsTable,
  flowDefinitionsTable,
  flowSubmissionsTable,
  flowAnalyticsEventsTable,
  authSessionsTable,
  allowedUsersTable,
} from "../lib/schema";

const app = new Hono<HonoEnv>();

// ── Super-admin middleware ────────────────────────────────────────────────────

app.use("/flows/tenants/:tenantId/flows*", async (c, next) => {
  const db = createDb(getDbUrl(c.env));
  const token = getCookie(c, "auth_token");
  if (!token) return c.json({ error: "Not authenticated" }, 401);

  const [session] = await db
    .select()
    .from(authSessionsTable)
    .where(and(eq(authSessionsTable.token, token), gt(authSessionsTable.expiresAt, new Date())))
    .limit(1);
  if (!session) return c.json({ error: "Session expired" }, 401);

  const [user] = await db
    .select()
    .from(allowedUsersTable)
    .where(eq(allowedUsersTable.phoneNumber, session.phoneNumber))
    .limit(1);
  if (!user || user.role !== "super_admin") return c.json({ error: "Super admin access required" }, 403);

  c.set("adminPhone", session.phoneNumber);
  await next();
});

app.use("/flows/tenants/:tenantId/analytics", async (c, next) => {
  const db = createDb(getDbUrl(c.env));
  const token = getCookie(c, "auth_token");
  if (!token) return c.json({ error: "Not authenticated" }, 401);

  const [session] = await db
    .select()
    .from(authSessionsTable)
    .where(and(eq(authSessionsTable.token, token), gt(authSessionsTable.expiresAt, new Date())))
    .limit(1);
  if (!session) return c.json({ error: "Session expired" }, 401);

  const [user] = await db
    .select()
    .from(allowedUsersTable)
    .where(eq(allowedUsersTable.phoneNumber, session.phoneNumber))
    .limit(1);
  if (!user || user.role !== "super_admin") return c.json({ error: "Super admin access required" }, 403);

  c.set("adminPhone", session.phoneNumber);
  await next();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const slugRe = /^[a-z0-9_-]{1,60}$/;

async function enrichFlowDef(db: Database, flow: typeof flowDefinitionsTable.$inferSelect) {
  const [subResult] = await db
    .select({ count: count() })
    .from(flowSubmissionsTable)
    .where(eq(flowSubmissionsTable.flowId, flow.id));
  return { ...flow, submissionCount: Number(subResult?.count ?? 0) };
}

// ── POST create flow ─────────────────────────────────────────────────────────

app.post("/flows/tenants/:tenantId/flows", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  if (isNaN(tenantId)) return c.json({ error: "Invalid tenantId" }, 400);

  const [tenant] = await db.select().from(flowTenantsTable).where(eq(flowTenantsTable.id, tenantId)).limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    slug?: string;
    metaFlowId?: string;
    description?: string;
  }>();

  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);

  const derivedSlug = body.slug?.trim()
    ? body.slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 60)
    : body.name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 60);

  if (!slugRe.test(derivedSlug)) {
    return c.json({ error: "slug must be lowercase alphanumeric, hyphens, underscores (max 60 chars)" }, 400);
  }

  const [existing] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.tenantId, tenantId), eq(flowDefinitionsTable.slug, derivedSlug)))
    .limit(1);
  if (existing) return c.json({ error: "A flow with this slug already exists for this tenant" }, 409);

  const [flow] = await db
    .insert(flowDefinitionsTable)
    .values({
      tenantId,
      name: body.name.trim(),
      slug: derivedSlug,
      metaFlowId: body.metaFlowId?.trim() || null,
      description: body.description?.trim() || null,
      isActive: true,
    })
    .returning();

  return c.json(await enrichFlowDef(db, flow), 201);
});

// ── GET list flows ───────────────────────────────────────────────────────────

app.get("/flows/tenants/:tenantId/flows", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  if (isNaN(tenantId)) return c.json({ error: "Invalid tenantId" }, 400);

  const [tenant] = await db.select().from(flowTenantsTable).where(eq(flowTenantsTable.id, tenantId)).limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const flows = await db
    .select()
    .from(flowDefinitionsTable)
    .where(eq(flowDefinitionsTable.tenantId, tenantId))
    .orderBy(desc(flowDefinitionsTable.createdAt));

  const enriched = await Promise.all(flows.map((f) => enrichFlowDef(db, f)));
  return c.json(enriched);
});

// ── GET single flow ──────────────────────────────────────────────────────────

app.get("/flows/tenants/:tenantId/flows/:flowId", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  const flowId = parseInt(c.req.param("flowId") ?? "", 10);
  if (isNaN(tenantId) || isNaN(flowId)) return c.json({ error: "Invalid id" }, 400);

  const [tenant] = await db.select().from(flowTenantsTable).where(eq(flowTenantsTable.id, tenantId)).limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const [flow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.id, flowId), eq(flowDefinitionsTable.tenantId, tenantId)))
    .limit(1);
  if (!flow) return c.json({ error: "Flow not found" }, 404);

  return c.json(await enrichFlowDef(db, flow));
});

// ── PATCH update flow ────────────────────────────────────────────────────────

app.patch("/flows/tenants/:tenantId/flows/:flowId", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  const flowId = parseInt(c.req.param("flowId") ?? "", 10);
  if (isNaN(tenantId) || isNaN(flowId)) return c.json({ error: "Invalid id" }, 400);

  const [flow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.id, flowId), eq(flowDefinitionsTable.tenantId, tenantId)))
    .limit(1);
  if (!flow) return c.json({ error: "Flow not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    description?: string;
    isActive?: boolean;
    metaFlowId?: string;
  }>();

  const updates: Partial<typeof flowDefinitionsTable.$inferInsert> = {};
  if (body.name?.trim()) updates.name = body.name.trim();
  if (body.description !== undefined) updates.description = body.description?.trim() || null;
  if (typeof body.isActive === "boolean") updates.isActive = body.isActive;
  if (body.metaFlowId !== undefined) updates.metaFlowId = body.metaFlowId?.trim() || null;

  if (Object.keys(updates).length === 0) return c.json({ error: "No valid fields to update" }, 400);

  const [updated] = await db
    .update(flowDefinitionsTable)
    .set(updates)
    .where(eq(flowDefinitionsTable.id, flowId))
    .returning();

  return c.json(await enrichFlowDef(db, updated));
});

// ── DELETE flow ──────────────────────────────────────────────────────────────

app.delete("/flows/tenants/:tenantId/flows/:flowId", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  const flowId = parseInt(c.req.param("flowId") ?? "", 10);
  if (isNaN(tenantId) || isNaN(flowId)) return c.json({ error: "Invalid id" }, 400);

  const [flow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.id, flowId), eq(flowDefinitionsTable.tenantId, tenantId)))
    .limit(1);
  if (!flow) return c.json({ error: "Flow not found" }, 404);

  await db.delete(flowDefinitionsTable).where(eq(flowDefinitionsTable.id, flowId));
  return c.json({ ok: true });
});

// ── GET tenant analytics ─────────────────────────────────────────────────────

app.get("/flows/tenants/:tenantId/analytics", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  if (isNaN(tenantId)) return c.json({ error: "Invalid tenantId" }, 400);

  const [tenant] = await db.select().from(flowTenantsTable).where(eq(flowTenantsTable.id, tenantId)).limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [totalResult] = await db
    .select({ count: count() })
    .from(flowSubmissionsTable)
    .where(eq(flowSubmissionsTable.tenantId, tenantId));

  const dailyCounts = await db
    .select({
      day: sql<string>`DATE(${flowSubmissionsTable.completedAt})`.as("day"),
      submissions: count(),
    })
    .from(flowSubmissionsTable)
    .where(
      and(
        eq(flowSubmissionsTable.tenantId, tenantId),
        gte(flowSubmissionsTable.completedAt, thirtyDaysAgo),
      ),
    )
    .groupBy(sql`DATE(${flowSubmissionsTable.completedAt})`)
    .orderBy(sql`DATE(${flowSubmissionsTable.completedAt})`);

  const flows = await db
    .select()
    .from(flowDefinitionsTable)
    .where(eq(flowDefinitionsTable.tenantId, tenantId));

  const flowStats = await Promise.all(
    flows.map(async (flow) => {
      const [subCount] = await db
        .select({ count: count() })
        .from(flowSubmissionsTable)
        .where(eq(flowSubmissionsTable.flowId, flow.id));

      const [totalEvents] = await db
        .select({ count: count() })
        .from(flowAnalyticsEventsTable)
        .where(
          and(
            eq(flowAnalyticsEventsTable.flowId, flow.id),
            eq(flowAnalyticsEventsTable.eventType, "init"),
          ),
        );

      const submissions = Number(subCount?.count ?? 0);
      const inits = Number(totalEvents?.count ?? 0);
      const completionRate = inits > 0 ? Math.round((submissions / inits) * 100) : null;

      return {
        flowId: flow.id,
        name: flow.name,
        slug: flow.slug,
        isActive: flow.isActive,
        submissions,
        inits,
        completionRate,
      };
    }),
  );

  const recent = await db
    .select()
    .from(flowSubmissionsTable)
    .where(eq(flowSubmissionsTable.tenantId, tenantId))
    .orderBy(desc(flowSubmissionsTable.completedAt))
    .limit(10);

  return c.json({
    totalSubmissions: Number(totalResult?.count ?? 0),
    dailyCounts,
    flowStats,
    recentSubmissions: recent,
  });
});

// ── GET flow analytics ───────────────────────────────────────────────────────

app.get("/flows/tenants/:tenantId/flows/:flowId/analytics", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  const flowId = parseInt(c.req.param("flowId") ?? "", 10);
  if (isNaN(tenantId) || isNaN(flowId)) return c.json({ error: "Invalid id" }, 400);

  const [flow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.id, flowId), eq(flowDefinitionsTable.tenantId, tenantId)))
    .limit(1);
  if (!flow) return c.json({ error: "Flow not found" }, 404);

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [subCount] = await db
    .select({ count: count() })
    .from(flowSubmissionsTable)
    .where(eq(flowSubmissionsTable.flowId, flowId));

  const [initCount] = await db
    .select({ count: count() })
    .from(flowAnalyticsEventsTable)
    .where(
      and(
        eq(flowAnalyticsEventsTable.flowId, flowId),
        eq(flowAnalyticsEventsTable.eventType, "init"),
      ),
    );

  const submissions = Number(subCount?.count ?? 0);
  const inits = Number(initCount?.count ?? 0);

  const dailyCounts = await db
    .select({
      day: sql<string>`DATE(${flowSubmissionsTable.completedAt})`.as("day"),
      submissions: count(),
    })
    .from(flowSubmissionsTable)
    .where(
      and(
        eq(flowSubmissionsTable.flowId, flowId),
        gte(flowSubmissionsTable.completedAt, thirtyDaysAgo),
      ),
    )
    .groupBy(sql`DATE(${flowSubmissionsTable.completedAt})`)
    .orderBy(sql`DATE(${flowSubmissionsTable.completedAt})`);

  const topScreens = await db
    .select({
      screenName: flowAnalyticsEventsTable.screenName,
      views: count(),
    })
    .from(flowAnalyticsEventsTable)
    .where(
      and(
        eq(flowAnalyticsEventsTable.flowId, flowId),
        eq(flowAnalyticsEventsTable.eventType, "screen_viewed"),
      ),
    )
    .groupBy(flowAnalyticsEventsTable.screenName)
    .orderBy(desc(count()))
    .limit(10);

  return c.json({
    submissions,
    inits,
    completionRate: inits > 0 ? Math.round((submissions / inits) * 100) : null,
    dailyCounts,
    topScreens,
  });
});

// ── GET submissions (paginated) ──────────────────────────────────────────────

app.get("/flows/tenants/:tenantId/flows/:flowId/submissions", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  const flowId = parseInt(c.req.param("flowId") ?? "", 10);
  if (isNaN(tenantId) || isNaN(flowId)) return c.json({ error: "Invalid id" }, 400);

  const [flow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.id, flowId), eq(flowDefinitionsTable.tenantId, tenantId)))
    .limit(1);
  if (!flow) return c.json({ error: "Flow not found" }, 404);

  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10)));
  const offset = (page - 1) * limit;

  const [totalResult] = await db
    .select({ count: count() })
    .from(flowSubmissionsTable)
    .where(eq(flowSubmissionsTable.flowId, flowId));

  const submissions = await db
    .select()
    .from(flowSubmissionsTable)
    .where(eq(flowSubmissionsTable.flowId, flowId))
    .orderBy(desc(flowSubmissionsTable.completedAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    total: Number(totalResult?.count ?? 0),
    page,
    limit,
    submissions,
  });
});

export default app;
