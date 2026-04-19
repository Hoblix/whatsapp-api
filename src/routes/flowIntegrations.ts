/**
 * Flow Integrations routes (super-admin) + Notion proxy — Hono / Cloudflare Workers
 *
 * GET/POST  /flows/tenants/:tenantId/flows/:flowId/integrations
 * PATCH/DELETE /flows/integrations/:id
 * GET/PUT  /flows/integrations/:id/mappings
 * POST     /flows/integrations/notion/databases
 * GET      /flows/integrations/:id/notion/database
 *
 * Exports pushSubmissionToIntegrations() for use in flowEndpoint.ts
 */

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { eq, and, gt } from "drizzle-orm";
import type { HonoEnv } from "../env";
import { createDb, getDbUrl, type Database } from "../lib/db";
import {
  flowIntegrationsTable,
  flowIntegrationMappingsTable,
  flowTenantsTable,
  flowDefinitionsTable,
  authSessionsTable,
  allowedUsersTable,
} from "../lib/schema";

const app = new Hono<HonoEnv>();

// ── Super-admin middleware ────────────────────────────────────────────────────

app.use("/flows/*", async (c, next) => {
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
  if (!user || user.role !== "super_admin") return c.json({ error: "Super admin required" }, 403);

  c.set("adminPhone", session.phoneNumber);
  await next();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function notionFetch(token: string, path: string, opts: RequestInit = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
  const body = (await res.json()) as any;
  if (!res.ok) return { ok: false as const, error: body?.message ?? `HTTP ${res.status}` };
  return { ok: true as const, data: body };
}

function maskConfig(config: Record<string, unknown>) {
  if (!config) return config;
  const masked = { ...config };
  if (masked.notionToken) masked.notionToken = "••••••••";
  return masked;
}

// ── List integrations ────────────────────────────────────────────────────────

app.get("/flows/tenants/:tenantId/flows/:flowId/integrations", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const flowId = parseInt(c.req.param("flowId"), 10);
  const tenantId = parseInt(c.req.param("tenantId"), 10);
  if (isNaN(flowId) || isNaN(tenantId)) return c.json({ error: "Invalid ids" }, 400);

  const rows = await db
    .select()
    .from(flowIntegrationsTable)
    .where(and(eq(flowIntegrationsTable.flowId, flowId), eq(flowIntegrationsTable.tenantId, tenantId)));

  const safe = rows.map((r) => ({ ...r, config: maskConfig(r.config as any) }));
  return c.json(safe);
});

// ── Create integration ───────────────────────────────────────────────────────

app.post("/flows/tenants/:tenantId/flows/:flowId/integrations", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const flowId = parseInt(c.req.param("flowId"), 10);
  const tenantId = parseInt(c.req.param("tenantId"), 10);

  const body = await c.req.json<{
    type: string;
    name: string;
    config: Record<string, unknown>;
  }>();

  if (!body.type || !body.name || !body.config) {
    return c.json({ error: "type, name and config are required" }, 400);
  }

  const [flow] = await db
    .select()
    .from(flowDefinitionsTable)
    .where(and(eq(flowDefinitionsTable.id, flowId), eq(flowDefinitionsTable.tenantId, tenantId)))
    .limit(1);
  if (!flow) return c.json({ error: "Flow not found" }, 404);

  const [row] = await db
    .insert(flowIntegrationsTable)
    .values({ flowId, tenantId, type: body.type, name: body.name, config: body.config, isActive: true })
    .returning();

  return c.json({ ...row, config: maskConfig(row.config as any) }, 201);
});

// ── Update integration ───────────────────────────────────────────────────────

app.patch("/flows/integrations/:id", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const body = await c.req.json<{
    name?: string;
    isActive?: boolean;
    config?: Record<string, unknown>;
  }>();

  const updates: Partial<typeof flowIntegrationsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.name !== undefined) updates.name = body.name;
  if (body.isActive !== undefined) updates.isActive = body.isActive;
  if (body.config !== undefined) {
    const [existing] = await db
      .select()
      .from(flowIntegrationsTable)
      .where(eq(flowIntegrationsTable.id, id))
      .limit(1);
    if (!existing) return c.json({ error: "Not found" }, 404);
    const existingConfig = existing.config as Record<string, unknown>;
    updates.config = {
      ...existingConfig,
      ...body.config,
      ...(body.config.notionToken === "" ? { notionToken: existingConfig.notionToken } : {}),
    };
  }

  const [row] = await db
    .update(flowIntegrationsTable)
    .set(updates)
    .where(eq(flowIntegrationsTable.id, id))
    .returning();
  if (!row) return c.json({ error: "Not found" }, 404);

  return c.json({ ...row, config: maskConfig(row.config as any) });
});

// ── Delete integration ───────────────────────────────────────────────────────

app.delete("/flows/integrations/:id", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  await db.delete(flowIntegrationsTable).where(eq(flowIntegrationsTable.id, id));
  return c.json({ ok: true });
});

// ── Get mappings ─────────────────────────────────────────────────────────────

app.get("/flows/integrations/:id/mappings", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const rows = await db
    .select()
    .from(flowIntegrationMappingsTable)
    .where(eq(flowIntegrationMappingsTable.integrationId, id));

  return c.json(rows);
});

// ── Replace mappings (full PUT) ──────────────────────────────────────────────

app.put("/flows/integrations/:id/mappings", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const mappings = await c.req.json<
    Array<{
      sourceField: string;
      targetField: string;
      targetFieldType?: string;
      isStatic?: boolean;
      staticValue?: string;
    }>
  >();

  if (!Array.isArray(mappings)) return c.json({ error: "mappings must be an array" }, 400);

  const [integration] = await db
    .select()
    .from(flowIntegrationsTable)
    .where(eq(flowIntegrationsTable.id, id))
    .limit(1);
  if (!integration) return c.json({ error: "Integration not found" }, 404);

  await db.delete(flowIntegrationMappingsTable).where(eq(flowIntegrationMappingsTable.integrationId, id));
  if (mappings.length > 0) {
    await db.insert(flowIntegrationMappingsTable).values(
      mappings.map((m) => ({
        integrationId: id,
        sourceField: m.sourceField ?? "",
        targetField: m.targetField,
        targetFieldType: m.targetFieldType ?? "rich_text",
        isStatic: m.isStatic ?? false,
        staticValue: m.staticValue ?? null,
      })),
    );
  }

  const rows = await db
    .select()
    .from(flowIntegrationMappingsTable)
    .where(eq(flowIntegrationMappingsTable.integrationId, id));

  return c.json(rows);
});

// ── Notion proxy: search databases ───────────────────────────────────────────

app.post("/flows/integrations/notion/databases", async (c) => {
  const body = await c.req.json<{ notionToken: string }>();
  if (!body.notionToken) return c.json({ error: "notionToken required" }, 400);

  const result = await notionFetch(body.notionToken, "/search", {
    method: "POST",
    body: JSON.stringify({ filter: { property: "object", value: "database" } }),
  });
  if (!result.ok) return c.json({ error: result.error }, 400);

  const dbs = (result.data.results as any[]).map((db: any) => ({
    id: db.id,
    title: db.title?.[0]?.plain_text ?? db.title?.[0]?.text?.content ?? "Untitled",
    url: db.url,
  }));
  return c.json(dbs);
});

// ── Notion proxy: get database schema ────────────────────────────────────────

app.get("/flows/integrations/:id/notion/database", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const [integration] = await db
    .select()
    .from(flowIntegrationsTable)
    .where(eq(flowIntegrationsTable.id, id))
    .limit(1);
  if (!integration) return c.json({ error: "Not found" }, 404);

  const cfg = integration.config as { notionToken?: string; databaseId?: string };
  if (!cfg.notionToken || !cfg.databaseId) {
    return c.json({ error: "Integration not fully configured" }, 400);
  }

  const result = await notionFetch(cfg.notionToken, `/databases/${cfg.databaseId}`);
  if (!result.ok) return c.json({ error: result.error }, 400);

  const props = Object.entries(result.data.properties as Record<string, any>).map(
    ([name, prop]: [string, any]) => ({ name, id: prop.id, type: prop.type }),
  );

  return c.json({
    id: result.data.id,
    title: result.data.title?.[0]?.plain_text ?? "Untitled",
    properties: props,
  });
});

export default app;

// ── Integration push (exported for use in flowEndpoint.ts) ───────────────────

export async function pushSubmissionToIntegrations(
  db: Database,
  flowId: number,
  tenantId: number,
  screenResponses: Record<string, unknown>,
  waPhone: string | null,
) {
  const integrations = await db
    .select()
    .from(flowIntegrationsTable)
    .where(
      and(
        eq(flowIntegrationsTable.flowId, flowId),
        eq(flowIntegrationsTable.tenantId, tenantId),
        eq(flowIntegrationsTable.isActive, true),
      ),
    );

  console.log(`[integrations] Found ${integrations.length} active integration(s) for flow ${flowId}`);

  for (const integration of integrations) {
    if (integration.type === "notion") {
      console.log(`[integrations] Pushing to Notion integration ${integration.id} (${integration.name})`);
      await pushToNotion(db, integration, screenResponses, waPhone).catch((err) =>
        console.error(`[integrations] Notion push failed for integration ${integration.id}:`, err),
      );
    }
  }
}

async function pushToNotion(
  db: Database,
  integration: typeof flowIntegrationsTable.$inferSelect,
  screenResponses: Record<string, unknown>,
  waPhone: string | null,
) {
  const cfg = integration.config as { notionToken?: string; databaseId?: string };
  if (!cfg.notionToken || !cfg.databaseId) return;

  const mappings = await db
    .select()
    .from(flowIntegrationMappingsTable)
    .where(eq(flowIntegrationMappingsTable.integrationId, integration.id));

  if (mappings.length === 0) return;

  const properties: Record<string, unknown> = {};

  for (const mapping of mappings) {
    let value: unknown;
    if (mapping.isStatic) {
      if (!mapping.staticValue) continue;
      value = mapping.staticValue;
    } else {
      value = screenResponses[mapping.sourceField];
      if (value === undefined || value === null) continue;
    }

    const strVal = String(value);
    const type = mapping.targetFieldType ?? "rich_text";

    if (type === "title") {
      properties[mapping.targetField] = { title: [{ text: { content: strVal } }] };
    } else if (type === "phone_number") {
      properties[mapping.targetField] = { phone_number: strVal };
    } else if (type === "email") {
      properties[mapping.targetField] = { email: strVal };
    } else if (type === "url") {
      properties[mapping.targetField] = { url: strVal };
    } else if (type === "select") {
      properties[mapping.targetField] = { select: { name: strVal } };
    } else if (type === "multi_select") {
      properties[mapping.targetField] = { multi_select: [{ name: strVal }] };
    } else if (type === "number") {
      properties[mapping.targetField] = { number: parseFloat(strVal) || 0 };
    } else if (type === "checkbox") {
      properties[mapping.targetField] = { checkbox: strVal === "true" || strVal === "yes" };
    } else if (type === "date") {
      properties[mapping.targetField] = { date: { start: strVal } };
    } else {
      properties[mapping.targetField] = {
        rich_text: [{ text: { content: strVal.slice(0, 2000) } }],
      };
    }
  }

  if (!Object.keys(properties).length) {
    console.warn(`[integrations] No properties built for Notion push — check field mappings`);
    return;
  }

  console.log(`[integrations] Pushing ${Object.keys(properties).length} properties to Notion DB ${cfg.databaseId}`);
  const result = await notionFetch(cfg.notionToken, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: cfg.databaseId },
      properties,
    }),
  });

  if (!result.ok) {
    console.error(`[integrations] Notion API error:`, result.error);
  } else {
    console.log(`[integrations] Notion page created OK`);
  }
}

/**
 * Upsert a Notion page by phone number. If a page already exists for the
 * given phone, patches it with the new properties. Otherwise creates a new
 * page. Used by reschedule flow to update the same row instead of duplicating.
 */
export async function upsertNotionPageByPhone(
  db: Database,
  flowId: number,
  tenantId: number,
  waPhone: string,
  overrideProperties: Record<string, unknown>,
) {
  const integrations = await db
    .select()
    .from(flowIntegrationsTable)
    .where(
      and(
        eq(flowIntegrationsTable.flowId, flowId),
        eq(flowIntegrationsTable.tenantId, tenantId),
        eq(flowIntegrationsTable.isActive, true),
      ),
    );

  for (const integration of integrations) {
    if (integration.type !== "notion") continue;
    const cfg = integration.config as { notionToken?: string; databaseId?: string };
    if (!cfg.notionToken || !cfg.databaseId) continue;

    // Find the field mapping that stores the phone number. Prefer explicit phone_number
    // type, fall back to sourceField == "wa_phone" (which is how Hoblix mapped it as a title).
    const mappings = await db
      .select()
      .from(flowIntegrationMappingsTable)
      .where(eq(flowIntegrationMappingsTable.integrationId, integration.id));
    const phoneMapping =
      mappings.find((m) => m.targetFieldType === "phone_number") ??
      mappings.find((m) => m.sourceField === "wa_phone");
    if (!phoneMapping) {
      console.warn(`[integrations] No phone/wa_phone mapping — can't upsert, falling back to create`);
      const createRes = await notionFetch(cfg.notionToken, "/pages", {
        method: "POST",
        body: JSON.stringify({ parent: { database_id: cfg.databaseId }, properties: overrideProperties }),
      });
      if (!createRes.ok) console.error(`[integrations] Notion create failed:`, createRes.error);
      continue;
    }

    // Try multiple phone formats — Notion may store as "919876543210", "9876543210",
    // "+919876543210", or with spaces. Query with OR filter covering common variants.
    const digitsOnly = waPhone.replace(/\D/g, "");
    const variants = new Set<string>([
      waPhone,                                  // as-received
      digitsOnly,                               // just digits (e.g. 919876543210)
      `+${digitsOnly}`,                         // with plus
      digitsOnly.length > 10 ? digitsOnly.slice(-10) : digitsOnly, // last 10 digits (India without CC)
      digitsOnly.length === 10 ? `91${digitsOnly}` : digitsOnly,  // with 91 prefix
    ]);

    // Build Notion filter based on the actual property type.
    // title/rich_text both use "rich_text" filter operator; phone_number uses "phone_number"
    const filterKey =
      phoneMapping.targetFieldType === "phone_number" ? "phone_number" :
      phoneMapping.targetFieldType === "title" ? "title" :
      "rich_text";
    const orFilters = Array.from(variants).map((v) => ({
      property: phoneMapping.targetField,
      [filterKey]: { equals: v },
    }));

    const queryRes = await notionFetch(cfg.notionToken, `/databases/${cfg.databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({
        filter: orFilters.length > 1 ? { or: orFilters } : orFilters[0],
        page_size: 1,
      }),
    });

    if (!queryRes.ok) {
      console.error(`[integrations] Notion query failed:`, queryRes.error);
      continue;
    }

    const existingPage = queryRes.data?.results?.[0];
    console.log(`[integrations] Notion lookup for ${waPhone} (variants: ${Array.from(variants).join(",")}) → ${existingPage ? `found page ${existingPage.id}` : "not found"}`);

    if (existingPage?.id) {
      // PATCH the existing page with new properties
      const patchRes = await notionFetch(cfg.notionToken, `/pages/${existingPage.id}`, {
        method: "PATCH",
        body: JSON.stringify({ properties: overrideProperties }),
      });
      if (!patchRes.ok) {
        console.error(`[integrations] Notion page update failed:`, patchRes.error);
      } else {
        console.log(`[integrations] Notion page ${existingPage.id} updated for phone ${waPhone}`);
      }
    } else {
      // No existing row — create new
      console.log(`[integrations] No existing Notion page for ${waPhone}, creating new`);
      const createRes = await notionFetch(cfg.notionToken, "/pages", {
        method: "POST",
        body: JSON.stringify({ parent: { database_id: cfg.databaseId }, properties: overrideProperties }),
      });
      if (!createRes.ok) console.error(`[integrations] Notion create failed:`, createRes.error);
    }
  }
}
