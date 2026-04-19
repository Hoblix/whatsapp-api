/**
 * Flow screens & routing rules routes (super-admin only) — Hono / Cloudflare Workers
 *
 * Screens:
 * GET/POST   .../flows/:flowId/screens
 * PATCH/DELETE .../flows/:flowId/screens/:screenDbId
 *
 * Rules:
 * GET/POST   .../screens/:screenDbId/rules
 * PATCH/DELETE .../screens/:screenDbId/rules/:ruleId
 * POST       .../screens/:screenDbId/rules/reorder
 */

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { eq, and, ne, gt, asc } from "drizzle-orm";
import type { HonoEnv } from "../env";
import { createDb, getDbUrl, type Database } from "../lib/db";
import {
  flowTenantsTable,
  flowDefinitionsTable,
  flowScreensTable,
  flowRoutingRulesTable,
  authSessionsTable,
  allowedUsersTable,
} from "../lib/schema";

const app = new Hono<HonoEnv>();

// ── Super-admin middleware ────────────────────────────────────────────────────

app.use("/flows/tenants/*", async (c, next) => {
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

// ── Shared resolver helpers ──────────────────────────────────────────────────

// v1 operators — reconciled with automationEngine.ts evaluateCondition().
// gt/lt were removed: automationEngine never handled them (silently returned false).
// If migration is needed for existing gt/lt conditions, see CLN-03 in REQUIREMENTS.md.
const VALID_OPERATORS = ["eq", "neq", "contains", "exists", "not_exists", "default"] as const;
type Operator = (typeof VALID_OPERATORS)[number];

function isValidOperator(op: string): op is Operator {
  return VALID_OPERATORS.includes(op as Operator);
}

// ── GET screens ──────────────────────────────────────────────────────────────

app.get("/flows/tenants/:tenantId/flows/:flowId/screens", async (c) => {
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

  const screens = await db
    .select()
    .from(flowScreensTable)
    .where(eq(flowScreensTable.flowId, flowId))
    .orderBy(asc(flowScreensTable.createdAt));

  return c.json(screens);
});

// ── POST create screen ───────────────────────────────────────────────────────

app.post("/flows/tenants/:tenantId/flows/:flowId/screens", async (c) => {
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

  const body = await c.req.json<{
    screenId?: string;
    label?: string;
    isFirst?: boolean;
    defaultNextScreen?: string;
    initData?: Record<string, unknown>;
  }>();

  if (!body.screenId?.trim()) return c.json({ error: "screenId is required" }, 400);
  if (!/^[A-Za-z0-9_-]+$/.test(body.screenId.trim())) {
    return c.json({ error: "screenId must contain only letters, digits, underscores, and hyphens" }, 400);
  }
  if (body.initData !== undefined && (typeof body.initData !== "object" || Array.isArray(body.initData))) {
    return c.json({ error: "initData must be a JSON object" }, 400);
  }

  const [existing] = await db
    .select()
    .from(flowScreensTable)
    .where(and(eq(flowScreensTable.flowId, flowId), eq(flowScreensTable.screenId, body.screenId.trim())))
    .limit(1);
  if (existing) return c.json({ error: "A screen with this screenId already exists for this flow" }, 409);

  const willBeFirst = body.isFirst ?? false;

  const screen = await db.transaction(async (tx) => {
    if (willBeFirst) {
      await tx
        .update(flowScreensTable)
        .set({ isFirst: false })
        .where(eq(flowScreensTable.flowId, flowId));
    }

    const [created] = await tx
      .insert(flowScreensTable)
      .values({
        flowId,
        tenantId,
        screenId: body.screenId!.trim(),
        label: body.label?.trim() || null,
        isFirst: willBeFirst,
        defaultNextScreen: body.defaultNextScreen?.trim() || null,
        initData: body.initData ?? null,
      })
      .returning();

    return created;
  });

  return c.json(screen, 201);
});

// ── PATCH update screen ──────────────────────────────────────────────────────

app.patch("/flows/tenants/:tenantId/flows/:flowId/screens/:screenDbId", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  const flowId = parseInt(c.req.param("flowId") ?? "", 10);
  const screenDbId = parseInt(c.req.param("screenDbId") ?? "", 10);
  if (isNaN(tenantId) || isNaN(flowId) || isNaN(screenDbId)) return c.json({ error: "Invalid id" }, 400);

  const [tenant] = await db.select().from(flowTenantsTable).where(eq(flowTenantsTable.id, tenantId)).limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);
  const [flow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.id, flowId), eq(flowDefinitionsTable.tenantId, tenantId)))
    .limit(1);
  if (!flow) return c.json({ error: "Flow not found" }, 404);

  const [screen] = await db
    .select()
    .from(flowScreensTable)
    .where(and(eq(flowScreensTable.id, screenDbId), eq(flowScreensTable.flowId, flowId)))
    .limit(1);
  if (!screen) return c.json({ error: "Screen not found" }, 404);

  const body = await c.req.json<{
    screenId?: string;
    label?: string;
    isFirst?: boolean;
    defaultNextScreen?: string;
    initData?: Record<string, unknown> | null;
  }>();

  if (body.initData !== undefined && body.initData !== null && (typeof body.initData !== "object" || Array.isArray(body.initData))) {
    return c.json({ error: "initData must be a JSON object or null" }, 400);
  }

  const coreUpdates: Partial<typeof flowScreensTable.$inferInsert> = {};

  if (body.screenId !== undefined) {
    if (!body.screenId.trim()) return c.json({ error: "screenId cannot be empty" }, 400);
    if (!/^[A-Za-z0-9_-]+$/.test(body.screenId.trim())) {
      return c.json({ error: "screenId must contain only letters, digits, underscores, and hyphens" }, 400);
    }
    if (body.screenId.trim() !== screen.screenId) {
      const [dup] = await db
        .select()
        .from(flowScreensTable)
        .where(and(eq(flowScreensTable.flowId, flowId), eq(flowScreensTable.screenId, body.screenId.trim())))
        .limit(1);
      if (dup) return c.json({ error: "A screen with this screenId already exists for this flow" }, 409);
    }
    coreUpdates.screenId = body.screenId.trim();
  }

  if (body.label !== undefined) coreUpdates.label = body.label?.trim() || null;
  if (body.defaultNextScreen !== undefined) coreUpdates.defaultNextScreen = body.defaultNextScreen?.trim() || null;
  if (body.initData !== undefined) coreUpdates.initData = body.initData;

  const settingFirst = typeof body.isFirst === "boolean" ? body.isFirst : null;

  if (settingFirst === null && Object.keys(coreUpdates).length === 0) {
    return c.json({ error: "No valid fields to update" }, 400);
  }

  let updated: typeof flowScreensTable.$inferSelect;

  if (settingFirst !== null) {
    updated = await db.transaction(async (tx) => {
      if (settingFirst) {
        await tx
          .update(flowScreensTable)
          .set({ isFirst: false })
          .where(and(eq(flowScreensTable.flowId, flowId), ne(flowScreensTable.id, screenDbId)));
      }

      const [row] = await tx
        .update(flowScreensTable)
        .set({ ...coreUpdates, isFirst: settingFirst })
        .where(eq(flowScreensTable.id, screenDbId))
        .returning();

      return row;
    });
  } else {
    const [row] = await db
      .update(flowScreensTable)
      .set(coreUpdates)
      .where(eq(flowScreensTable.id, screenDbId))
      .returning();
    updated = row;
  }

  return c.json(updated);
});

// ── DELETE screen ────────────────────────────────────────────────────────────

app.delete("/flows/tenants/:tenantId/flows/:flowId/screens/:screenDbId", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  const flowId = parseInt(c.req.param("flowId") ?? "", 10);
  const screenDbId = parseInt(c.req.param("screenDbId") ?? "", 10);
  if (isNaN(tenantId) || isNaN(flowId) || isNaN(screenDbId)) return c.json({ error: "Invalid id" }, 400);

  const [tenant] = await db.select().from(flowTenantsTable).where(eq(flowTenantsTable.id, tenantId)).limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);
  const [flow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.id, flowId), eq(flowDefinitionsTable.tenantId, tenantId)))
    .limit(1);
  if (!flow) return c.json({ error: "Flow not found" }, 404);

  const [screen] = await db
    .select()
    .from(flowScreensTable)
    .where(and(eq(flowScreensTable.id, screenDbId), eq(flowScreensTable.flowId, flowId)))
    .limit(1);
  if (!screen) return c.json({ error: "Screen not found" }, 404);

  await db.delete(flowScreensTable).where(eq(flowScreensTable.id, screenDbId));
  return c.json({ ok: true });
});

// ── GET rules ────────────────────────────────────────────────────────────────

app.get("/flows/tenants/:tenantId/flows/:flowId/screens/:screenDbId/rules", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  const flowId = parseInt(c.req.param("flowId") ?? "", 10);
  const screenDbId = parseInt(c.req.param("screenDbId") ?? "", 10);
  if (isNaN(tenantId) || isNaN(flowId) || isNaN(screenDbId)) return c.json({ error: "Invalid id" }, 400);

  const [tenant] = await db.select().from(flowTenantsTable).where(eq(flowTenantsTable.id, tenantId)).limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);
  const [flow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.id, flowId), eq(flowDefinitionsTable.tenantId, tenantId)))
    .limit(1);
  if (!flow) return c.json({ error: "Flow not found" }, 404);
  const [screen] = await db
    .select()
    .from(flowScreensTable)
    .where(and(eq(flowScreensTable.id, screenDbId), eq(flowScreensTable.flowId, flowId)))
    .limit(1);
  if (!screen) return c.json({ error: "Screen not found" }, 404);

  const rules = await db
    .select()
    .from(flowRoutingRulesTable)
    .where(eq(flowRoutingRulesTable.screenDbId, screenDbId))
    .orderBy(asc(flowRoutingRulesTable.priority));

  return c.json(rules);
});

// ── POST create rule ─────────────────────────────────────────────────────────

app.post("/flows/tenants/:tenantId/flows/:flowId/screens/:screenDbId/rules", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  const flowId = parseInt(c.req.param("flowId") ?? "", 10);
  const screenDbId = parseInt(c.req.param("screenDbId") ?? "", 10);
  if (isNaN(tenantId) || isNaN(flowId) || isNaN(screenDbId)) return c.json({ error: "Invalid id" }, 400);

  const [tenant] = await db.select().from(flowTenantsTable).where(eq(flowTenantsTable.id, tenantId)).limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);
  const [flow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.id, flowId), eq(flowDefinitionsTable.tenantId, tenantId)))
    .limit(1);
  if (!flow) return c.json({ error: "Flow not found" }, 404);
  const [screen] = await db
    .select()
    .from(flowScreensTable)
    .where(and(eq(flowScreensTable.id, screenDbId), eq(flowScreensTable.flowId, flowId)))
    .limit(1);
  if (!screen) return c.json({ error: "Screen not found" }, 404);

  const body = await c.req.json<{
    priority?: number;
    fieldName?: string;
    operator?: string;
    fieldValue?: string;
    nextScreen?: string;
    injectData?: Record<string, unknown>;
  }>();

  if (!body.fieldName?.trim()) return c.json({ error: "fieldName is required" }, 400);
  if (!body.operator || !isValidOperator(body.operator)) {
    return c.json({ error: `operator must be one of: ${VALID_OPERATORS.join(", ")}` }, 400);
  }
  if (!body.nextScreen?.trim()) return c.json({ error: "nextScreen is required" }, 400);
  if (body.injectData !== undefined && body.injectData !== null && (typeof body.injectData !== "object" || Array.isArray(body.injectData))) {
    return c.json({ error: "injectData must be a JSON object" }, 400);
  }

  const [rule] = await db
    .insert(flowRoutingRulesTable)
    .values({
      screenDbId,
      flowId,
      tenantId,
      priority: typeof body.priority === "number" ? body.priority : 0,
      fieldName: body.fieldName.trim(),
      operator: body.operator,
      fieldValue: body.fieldValue?.trim() ?? null,
      nextScreen: body.nextScreen.trim(),
      injectData: body.injectData ?? null,
    })
    .returning();

  return c.json(rule, 201);
});

// ── PATCH update rule ────────────────────────────────────────────────────────

app.patch("/flows/tenants/:tenantId/flows/:flowId/screens/:screenDbId/rules/:ruleId", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  const flowId = parseInt(c.req.param("flowId") ?? "", 10);
  const screenDbId = parseInt(c.req.param("screenDbId") ?? "", 10);
  const ruleId = parseInt(c.req.param("ruleId") ?? "", 10);
  if (isNaN(tenantId) || isNaN(flowId) || isNaN(screenDbId) || isNaN(ruleId)) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const [tenant] = await db.select().from(flowTenantsTable).where(eq(flowTenantsTable.id, tenantId)).limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);
  const [flow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.id, flowId), eq(flowDefinitionsTable.tenantId, tenantId)))
    .limit(1);
  if (!flow) return c.json({ error: "Flow not found" }, 404);
  const [screen] = await db
    .select()
    .from(flowScreensTable)
    .where(and(eq(flowScreensTable.id, screenDbId), eq(flowScreensTable.flowId, flowId)))
    .limit(1);
  if (!screen) return c.json({ error: "Screen not found" }, 404);

  const [rule] = await db
    .select()
    .from(flowRoutingRulesTable)
    .where(and(eq(flowRoutingRulesTable.id, ruleId), eq(flowRoutingRulesTable.screenDbId, screenDbId)))
    .limit(1);
  if (!rule) return c.json({ error: "Rule not found" }, 404);

  const body = await c.req.json<{
    priority?: number;
    fieldName?: string;
    operator?: string;
    fieldValue?: string | null;
    nextScreen?: string;
    injectData?: Record<string, unknown> | null;
  }>();

  const updates: Partial<typeof flowRoutingRulesTable.$inferInsert> = {};

  if (typeof body.priority === "number") updates.priority = body.priority;
  if (body.fieldName !== undefined) {
    if (!body.fieldName.trim()) return c.json({ error: "fieldName cannot be empty" }, 400);
    updates.fieldName = body.fieldName.trim();
  }
  if (body.operator !== undefined) {
    if (!isValidOperator(body.operator)) {
      return c.json({ error: `operator must be one of: ${VALID_OPERATORS.join(", ")}` }, 400);
    }
    updates.operator = body.operator;
  }
  if (body.fieldValue !== undefined) updates.fieldValue = body.fieldValue?.trim() ?? null;
  if (body.nextScreen !== undefined) {
    if (!body.nextScreen.trim()) return c.json({ error: "nextScreen cannot be empty" }, 400);
    updates.nextScreen = body.nextScreen.trim();
  }
  if (body.injectData !== undefined) {
    if (body.injectData !== null && (typeof body.injectData !== "object" || Array.isArray(body.injectData))) {
      return c.json({ error: "injectData must be a JSON object or null" }, 400);
    }
    updates.injectData = body.injectData;
  }

  if (Object.keys(updates).length === 0) return c.json({ error: "No valid fields to update" }, 400);

  const [updated] = await db
    .update(flowRoutingRulesTable)
    .set(updates)
    .where(eq(flowRoutingRulesTable.id, ruleId))
    .returning();

  return c.json(updated);
});

// ── DELETE rule ──────────────────────────────────────────────────────────────

app.delete("/flows/tenants/:tenantId/flows/:flowId/screens/:screenDbId/rules/:ruleId", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  const flowId = parseInt(c.req.param("flowId") ?? "", 10);
  const screenDbId = parseInt(c.req.param("screenDbId") ?? "", 10);
  const ruleId = parseInt(c.req.param("ruleId") ?? "", 10);
  if (isNaN(tenantId) || isNaN(flowId) || isNaN(screenDbId) || isNaN(ruleId)) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const [tenant] = await db.select().from(flowTenantsTable).where(eq(flowTenantsTable.id, tenantId)).limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);
  const [flow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.id, flowId), eq(flowDefinitionsTable.tenantId, tenantId)))
    .limit(1);
  if (!flow) return c.json({ error: "Flow not found" }, 404);
  const [screen] = await db
    .select()
    .from(flowScreensTable)
    .where(and(eq(flowScreensTable.id, screenDbId), eq(flowScreensTable.flowId, flowId)))
    .limit(1);
  if (!screen) return c.json({ error: "Screen not found" }, 404);

  const [rule] = await db
    .select()
    .from(flowRoutingRulesTable)
    .where(and(eq(flowRoutingRulesTable.id, ruleId), eq(flowRoutingRulesTable.screenDbId, screenDbId)))
    .limit(1);
  if (!rule) return c.json({ error: "Rule not found" }, 404);

  await db.delete(flowRoutingRulesTable).where(eq(flowRoutingRulesTable.id, ruleId));
  return c.json({ ok: true });
});

// ── POST reorder rules ───────────────────────────────────────────────────────

app.post("/flows/tenants/:tenantId/flows/:flowId/screens/:screenDbId/rules/reorder", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const tenantId = parseInt(c.req.param("tenantId") ?? "", 10);
  const flowId = parseInt(c.req.param("flowId") ?? "", 10);
  const screenDbId = parseInt(c.req.param("screenDbId") ?? "", 10);
  if (isNaN(tenantId) || isNaN(flowId) || isNaN(screenDbId)) return c.json({ error: "Invalid id" }, 400);

  const [tenant] = await db.select().from(flowTenantsTable).where(eq(flowTenantsTable.id, tenantId)).limit(1);
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);
  const [flow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.id, flowId), eq(flowDefinitionsTable.tenantId, tenantId)))
    .limit(1);
  if (!flow) return c.json({ error: "Flow not found" }, 404);
  const [screen] = await db
    .select()
    .from(flowScreensTable)
    .where(and(eq(flowScreensTable.id, screenDbId), eq(flowScreensTable.flowId, flowId)))
    .limit(1);
  if (!screen) return c.json({ error: "Screen not found" }, 404);

  const body = await c.req.json<{ ruleIds?: number[] }>();
  const { ruleIds } = body;
  if (!Array.isArray(ruleIds) || ruleIds.some((id) => typeof id !== "number")) {
    return c.json({ error: "ruleIds must be an array of numbers" }, 400);
  }

  const existingRules = await db
    .select({ id: flowRoutingRulesTable.id })
    .from(flowRoutingRulesTable)
    .where(eq(flowRoutingRulesTable.screenDbId, screenDbId));

  const existingIds = new Set(existingRules.map((r) => r.id));

  if (ruleIds.length !== existingIds.size) {
    return c.json(
      { error: `ruleIds must contain exactly ${existingIds.size} rule(s) — one per existing rule, no duplicates` },
      400,
    );
  }

  for (const id of ruleIds) {
    if (!existingIds.has(id)) {
      return c.json({ error: `Rule id ${id} does not belong to this screen` }, 400);
    }
  }

  await db.transaction(async (tx) => {
    await Promise.all(
      ruleIds.map((id, idx) =>
        tx
          .update(flowRoutingRulesTable)
          .set({ priority: idx * 10 })
          .where(and(eq(flowRoutingRulesTable.id, id), eq(flowRoutingRulesTable.screenDbId, screenDbId))),
      ),
    );
  });

  const rules = await db
    .select()
    .from(flowRoutingRulesTable)
    .where(eq(flowRoutingRulesTable.screenDbId, screenDbId))
    .orderBy(asc(flowRoutingRulesTable.priority));

  return c.json(rules);
});

export default app;
