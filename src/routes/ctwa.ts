/**
 * Click-to-WhatsApp Ads (CTWA) routes + fire engine — Hono / Cloudflare Workers
 *
 * GET    /ctwa/rules           — list all rules
 * POST   /ctwa/rules           — create a rule
 * PATCH  /ctwa/rules/:id       — update a rule
 * DELETE /ctwa/rules/:id       — delete a rule
 * GET    /ctwa/events          — paginated attribution log
 *
 * Exports fireCTWARules() for webhook handler consumption.
 */

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { eq, and, gt, desc, asc, gte } from "drizzle-orm";
import type { HonoEnv } from "../env";
import { createDb, getDbUrl, type Database } from "../lib/db";
import {
  ctwaRulesTable,
  ctwaEventsTable,
  flowDefinitionsTable,
  authSessionsTable,
  allowedUsersTable,
} from "../lib/schema";
import { callWhatsAppAPI } from "./sendHelpers";

const app = new Hono<HonoEnv>();

// ── Super-admin middleware ────────────────────────────────────────────────────

app.use("/ctwa/*", async (c, next) => {
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

// ── List rules ───────────────────────────────────────────────────────────────

app.get("/ctwa/rules", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const rules = await db
    .select()
    .from(ctwaRulesTable)
    .orderBy(asc(ctwaRulesTable.priority), desc(ctwaRulesTable.createdAt));
  return c.json(rules);
});

// ── Create rule ──────────────────────────────────────────────────────────────

app.post("/ctwa/rules", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const body = await c.req.json<{
    name: string;
    description?: string;
    matchType: "any" | "ad_id" | "source_url_contains";
    matchValue?: string;
    actionType: "template" | "flow";
    actionConfig: Record<string, unknown>;
    priority?: number;
    isActive?: boolean;
  }>();

  if (!body.name || !body.matchType || !body.actionType || !body.actionConfig) {
    return c.json({ error: "name, matchType, actionType, and actionConfig are required" }, 400);
  }

  const [row] = await db
    .insert(ctwaRulesTable)
    .values({
      name: body.name,
      description: body.description ?? null,
      matchType: body.matchType,
      matchValue: body.matchValue ?? null,
      actionType: body.actionType,
      actionConfig: body.actionConfig,
      priority: body.priority ?? 0,
      isActive: body.isActive ?? true,
    })
    .returning();

  return c.json(row, 201);
});

// ── Update rule ──────────────────────────────────────────────────────────────

app.patch("/ctwa/rules/:id", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const body = await c.req.json<{
    name?: string;
    description?: string;
    matchType?: "any" | "ad_id" | "source_url_contains";
    matchValue?: string;
    actionType?: "template" | "flow";
    actionConfig?: Record<string, unknown>;
    priority?: number;
    isActive?: boolean;
  }>();

  const updates: Partial<typeof ctwaRulesTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.matchType !== undefined) updates.matchType = body.matchType;
  if (body.matchValue !== undefined) updates.matchValue = body.matchValue;
  if (body.actionType !== undefined) updates.actionType = body.actionType;
  if (body.actionConfig !== undefined) updates.actionConfig = body.actionConfig;
  if (body.priority !== undefined) updates.priority = body.priority;
  if (body.isActive !== undefined) updates.isActive = body.isActive;

  const [row] = await db
    .update(ctwaRulesTable)
    .set(updates)
    .where(eq(ctwaRulesTable.id, id))
    .returning();

  if (!row) return c.json({ error: "Rule not found" }, 404);
  return c.json(row);
});

// ── Delete rule ──────────────────────────────────────────────────────────────

app.delete("/ctwa/rules/:id", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  await db.delete(ctwaRulesTable).where(eq(ctwaRulesTable.id, id));
  return c.json({ ok: true });
});

// ── List events (attribution log) ────────────────────────────────────────────

app.get("/ctwa/events", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  const events = await db
    .select()
    .from(ctwaEventsTable)
    .orderBy(desc(ctwaEventsTable.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({ events, limit, offset });
});

export default app;

// ── CTWA fire-rules engine ───────────────────────────────────────────────────
// Called by the webhook handler when a referral is detected.

export async function fireCTWARules(
  db: Database,
  phone: string,
  conversationId: number,
  referral: Record<string, unknown>,
  accessToken: string,
  phoneNumberId: string,
) {
  const adId = (referral.source_id ?? referral.ad_id ?? "") as string;
  const adSourceUrl = (referral.source_url ?? "") as string;
  const adHeadline = (referral.headline ?? "") as string;
  const adBody = (referral.body ?? "") as string;
  const adMediaType = (referral.media_type ?? "") as string;

  // ── 24h idempotency guard ──────────────────────────────────────────────────
  if (adId) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [recentEvent] = await db
      .select()
      .from(ctwaEventsTable)
      .where(
        and(
          eq(ctwaEventsTable.phoneNumber, phone),
          eq(ctwaEventsTable.adId, adId),
          gte(ctwaEventsTable.createdAt, cutoff),
        ),
      )
      .limit(1);
    if (recentEvent) {
      console.log(`[ctwa] Skipping duplicate ad event for phone=${phone} ad_id=${adId}`);
      return;
    }
  }

  // ── Load active rules ordered by priority ──────────────────────────────────
  const rules = await db
    .select()
    .from(ctwaRulesTable)
    .where(eq(ctwaRulesTable.isActive, true))
    .orderBy(asc(ctwaRulesTable.priority));

  let matchedRule: typeof ctwaRulesTable.$inferSelect | null = null;
  for (const rule of rules) {
    if (rule.matchType === "any") {
      matchedRule = rule;
      break;
    } else if (rule.matchType === "ad_id" && adId && rule.matchValue === adId) {
      matchedRule = rule;
      break;
    } else if (
      rule.matchType === "source_url_contains" &&
      adSourceUrl &&
      rule.matchValue &&
      adSourceUrl.includes(rule.matchValue)
    ) {
      matchedRule = rule;
      break;
    }
  }

  let actionFired = false;
  let ruleId: number | null = null;

  if (matchedRule) {
    ruleId = matchedRule.id;
    try {
      await fireAction(db, phone, matchedRule, accessToken, phoneNumberId);
      actionFired = true;
      console.log(`[ctwa] Fired rule "${matchedRule.name}" (id=${matchedRule.id}) for phone=${phone}`);
    } catch (err) {
      console.error(`[ctwa] Failed to fire rule "${matchedRule.name}":`, err);
    }
  } else {
    console.log(`[ctwa] No matching rule for phone=${phone} ad_id=${adId}`);
  }

  // ── Log the event ──────────────────────────────────────────────────────────
  await db
    .insert(ctwaEventsTable)
    .values({
      conversationId,
      phoneNumber: phone,
      adId: adId || null,
      adSourceUrl: adSourceUrl || null,
      adHeadline: adHeadline || null,
      adBody: adBody || null,
      adMediaType: adMediaType || null,
      ruleId,
      actionFired,
      rawReferral: referral,
    })
    .catch((err) => console.error("[ctwa] Failed to log ctwa event:", err));
}

async function fireAction(
  db: Database,
  phone: string,
  rule: typeof ctwaRulesTable.$inferSelect,
  accessToken: string,
  phoneNumberId: string,
) {
  const cfg = rule.actionConfig as Record<string, unknown>;

  if (rule.actionType === "template") {
    const templateName = cfg.templateName as string;
    const languageCode = (cfg.languageCode as string) ?? "en_US";
    const components = (cfg.components as any[]) ?? [];

    const payload: any = {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: { name: templateName, language: { code: languageCode } },
    };
    if (components.length > 0) payload.template.components = components;

    await callWhatsAppAPI(payload, accessToken, phoneNumberId);
  } else if (rule.actionType === "flow") {
    const flowDbId = cfg.flowDbId as number;
    const ctaText = (cfg.ctaText as string) ?? "Get Started";
    const messageBody = (cfg.messageBody as string) ?? "We'd love to help you!";
    const header = cfg.header as string | undefined;

    const [flowDef] = await db
      .select()
      .from(flowDefinitionsTable)
      .where(eq(flowDefinitionsTable.id, flowDbId))
      .limit(1);
    if (!flowDef || !flowDef.metaFlowId) {
      throw new Error(`Flow definition ${flowDbId} not found or has no Meta flow_id`);
    }

    const interactive: any = {
      type: "flow",
      body: { text: messageBody },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: (cfg.flowToken as string) || "UNUSED",
          flow_id: flowDef.metaFlowId,
          flow_cta: ctaText,
          flow_action: "navigate",
        },
      },
    };
    if (header) {
      interactive.header = { type: "text", text: header };
    }

    await callWhatsAppAPI(
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "interactive",
        interactive,
      },
      accessToken,
      phoneNumberId,
    );
  }
}
