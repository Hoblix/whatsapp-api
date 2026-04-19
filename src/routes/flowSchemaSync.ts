/**
 * Flow schema sync routes — Hono / Cloudflare Workers
 *
 * POST /flows/:flowId/sync    Sync flow field schema from Meta Graph API
 * GET  /templates/enriched    List templates with flow_id detection
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { HonoEnv } from "../env";
import { META_GRAPH_API_VERSION } from "../env";
import { createDb, getDbUrl } from "../lib/db";
import {
  upsertFlowFieldSchema,
  getActiveSchemaByFlowId,
} from "../lib/schemaAccessors";
import {
  fetchFlowJson,
  extractEnumFields,
  mergeFieldValues,
} from "../lib/parseFlowJson";
import { enrichTemplatesWithFlowInfo } from "../lib/parseTemplateCta";
import {
  flowDefinitionsTable,
  flowRoutingRulesTable,
} from "../lib/schema";

const app = new Hono<HonoEnv>();

// ── Rate limit cooldown (seconds) ───────────────────────────────────────────
const SYNC_COOLDOWN_MS = 60_000;

// ── POST /flows/:flowId/sync ────────────────────────────────────────────────

app.post("/flows/:flowId/sync", async (c) => {
  const flowId = c.req.param("flowId");
  if (!flowId?.trim()) {
    return c.json({ error: "flowId is required" }, 400);
  }

  const db = createDb(getDbUrl(c.env));
  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;

  try {
    // Rate limit check: if synced within last 60 seconds, return cached
    const existing = await getActiveSchemaByFlowId(db, flowId);
    if (existing?.syncedAt) {
      const elapsed = Date.now() - new Date(existing.syncedAt).getTime();
      if (elapsed < SYNC_COOLDOWN_MS) {
        return c.json({
          success: true,
          fields_count: Array.isArray(existing.fields) ? existing.fields.length : 0,
          flow_version: existing.flowVersion,
          fields: Array.isArray(existing.fields) ? existing.fields : [],
          cached: true,
          synced_at: existing.syncedAt instanceof Date
            ? existing.syncedAt.toISOString()
            : String(existing.syncedAt),
        });
      }
    }

    // Fetch flow JSON from Meta
    const flowJson = await fetchFlowJson(flowId, accessToken, META_GRAPH_API_VERSION);

    // Extract enum fields
    let fields = extractEnumFields(flowJson);

    // Merge with or build from DB routing rules
    try {
      const [flowDef] = await db
        .select()
        .from(flowDefinitionsTable)
        .where(eq(flowDefinitionsTable.metaFlowId, flowId))
        .limit(1);

      if (flowDef) {
        const routingRules = await db
          .select()
          .from(flowRoutingRulesTable)
          .where(eq(flowRoutingRulesTable.flowId, flowDef.id));

        const dbRules = routingRules
          .filter((r) => r.fieldValue != null)
          .map((r) => ({
            fieldKey: r.fieldName,
            value: r.fieldValue!,
          }));

        if (dbRules.length > 0) {
          if (fields.length > 0) {
            // Merge DB values into existing fields (Meta is authoritative)
            fields = mergeFieldValues(fields, dbRules);
          } else {
            // No fields from Meta flow JSON — build fields entirely from routing rules
            // Group rules by field name to create enum fields
            const fieldMap = new Map<string, Set<string>>();
            for (const rule of dbRules) {
              if (!fieldMap.has(rule.fieldKey)) {
                fieldMap.set(rule.fieldKey, new Set());
              }
              fieldMap.get(rule.fieldKey)!.add(rule.value);
            }
            fields = Array.from(fieldMap.entries()).map(([key, values]) => ({
              field_key: key,
              label: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " "),
              type: "enum" as const,
              values: Array.from(values),
              screen_id: "routing_rules",
            }));
          }
        }
      }
    } catch {
      // Skip if flow definition lookup fails — Meta fields are sufficient
    }

    // Upsert schema
    const schema = await upsertFlowFieldSchema(db, {
      flowId,
      flowVersion: flowJson.version,
      fields,
      status: "active",
    });

    return c.json({
      success: true,
      fields_count: fields.length,
      flow_version: flowJson.version,
      fields,
      synced_at: schema.syncedAt instanceof Date
        ? schema.syncedAt.toISOString()
        : String(schema.syncedAt),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Distinguish Meta API errors from internal errors
    if (message.includes("Meta API error")) {
      console.error(`[sync] Meta API error for flow ${flowId}:`, message);
      return c.json(
        { error: `Could not load response options: ${message}` },
        502,
      );
    }

    console.error(`[POST /flows/${flowId}/sync]`, message);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── GET /templates/enriched ─────────────────────────────────────────────────

app.get("/templates/enriched", async (c) => {
  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = c.env.WHATSAPP_WABA_ID;

  try {
    const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${wabaId}/message_templates?status=APPROVED&limit=100&fields=name,status,language,category,components`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as { data?: unknown[]; error?: { message: string } };

    if (!res.ok) {
      throw new Error(data?.error?.message ?? `Meta API error ${res.status}`);
    }

    const templates = (data.data ?? []) as Array<{ components?: any[] }>;
    const enriched = enrichTemplatesWithFlowInfo(templates);

    return c.json({ data: enriched });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

export default app;
